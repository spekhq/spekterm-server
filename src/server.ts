/**
 * The server process (`server-connection` and `server-operation` specs): HTTP(S), `/healthz`, the `/connect`
 * WebSocket endpoint, the revocation sweep and shutdown.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { type Config, ConfigError, loadConfig } from './config.ts'
import { Connection, type ConnectionHost, DEFAULT_TIMINGS, type Timings } from './connection.ts'
import { type Database, openDataDir, truncateWal } from './db.ts'
import { Delivery } from './delivery.ts'
import { expireOverdue } from './handoffs.ts'
import { CLOSE_CODES, MAX_FRAME_BYTES } from './protocol.ts'
import { type Clock, getTeamName, revokedAmong } from './team.ts'
import { type TlsMaterial, loadTls } from './tls.ts'

export const CONNECT_PATH = '/connect'

export interface ServerOptions {
  db: Database
  tls?: TlsMaterial | null
  now?: Clock
  timings?: Partial<Timings>
  /** How often to look for devices revoked by another process. */
  sweepIntervalMs?: number
  /** How often to expire overdue handoffs and truncate the write-ahead log. */
  maintenanceIntervalMs?: number
  /** The most handoffs one member may send in any hour. */
  handoffRatePerHour?: number
  /** The `/healthz` check; throws when unhealthy. Defaults to a read of the team table. */
  healthCheck?: () => void
  log?: (message: string) => void
}

export interface RunningServer {
  readonly port: number
  /** Live connections of authenticated devices, by device id. */
  readonly devices: ReadonlyMap<string, Connection>
  readonly delivery: Delivery
  /** Runs the maintenance step now: expire overdue handoffs, truncate the write-ahead log. */
  maintain(): { expired: string[]; truncated: boolean }
  /** Stops accepting, closes every connection with 1001, and closes the database. */
  close(): Promise<void>
}

export function defaultLog(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`)
}

export async function startServer(port: number, options: ServerOptions): Promise<RunningServer> {
  const { db } = options
  const now = options.now ?? Date.now
  const log = options.log ?? defaultLog
  const timings: Timings = { ...DEFAULT_TIMINGS, ...options.timings }
  const sweepIntervalMs = options.sweepIntervalMs ?? 5_000
  const maintenanceIntervalMs = options.maintenanceIntervalMs ?? 60_000
  const healthCheck = options.healthCheck ?? (() => void getTeamName(db))
  const delivery = new Delivery(db, now, log)

  const devices = new Map<string, Connection>()
  const connections = new Set<Connection>()

  const host: ConnectionHost = {
    db,
    now,
    timings,
    log,
    register(deviceId, connection) {
      const older = devices.get(deviceId)
      devices.set(deviceId, connection)
      if (older !== undefined && older !== connection) {
        older.close(CLOSE_CODES.REPLACED, 'replaced by a newer connection of this device')
      }
    },
    unregister(deviceId, connection, reason) {
      if (devices.get(deviceId) === connection) devices.delete(deviceId)
      delivery.onClosed(connection, reason)
    },
    ready(connection) {
      delivery.onReady(connection)
    },
    handoffRatePerHour: options.handoffRatePerHour ?? 30,
    handoffSent(handoffId, recipientMemberId) {
      delivery.onSent(handoffId, recipientMemberId)
    },
    handoffAcknowledged(handoffId) {
      delivery.onAcknowledged(handoffId)
    },
  }

  const handleRequest = (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (req.method === 'GET' && path === '/healthz') {
      let healthy = true
      try {
        healthCheck()
      } catch (error) {
        healthy = false
        log(`health check failed: ${(error as Error).message}`)
      }
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'text/plain' })
      res.end(healthy ? 'ok\n' : 'unavailable\n')
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found\n')
  }

  const http: HttpServer =
    options.tls != null
      ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key, minVersion: 'TLSv1.2' }, handleRequest)
      : createHttpServer(handleRequest)

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {})
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path !== CONNECT_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connection = new Connection(ws, host)
      connections.add(connection)
      ws.on('close', () => connections.delete(connection))
    })
  })

  // Revocations written by the admin command line (another process) reach live connections here.
  const sweep = setInterval(() => {
    if (devices.size === 0) return
    try {
      for (const deviceId of revokedAmong(db, [...devices.keys()])) {
        log(`device ${deviceId} was revoked; closing its connection`)
        devices.get(deviceId)?.close(CLOSE_CODES.REVOKED, 'device revoked')
      }
    } catch (error) {
      log(`revocation sweep failed: ${(error as Error).message}`)
    }
  }, sweepIntervalMs)

  // Expire overdue handoffs, then truncate the WAL so cleared text leaves the files (design D7).
  const maintain = () => {
    let expired: string[] = []
    try {
      expired = expireOverdue(db, now)
      for (const id of expired) log(`handoff ${id} expired`)
    } catch (error) {
      log(`expiring handoffs failed: ${(error as Error).message}`)
    }
    const truncated = truncateWal(db)
    return { expired, truncated }
  }
  const maintenance = setInterval(maintain, maintenanceIntervalMs)

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(port, () => {
      http.off('error', reject)
      resolve()
    })
  })

  let closing: Promise<void> | null = null
  return {
    port: (http.address() as AddressInfo).port,
    devices,
    delivery,
    maintain,
    close() {
      closing ??= (async () => {
        delivery.closing = true
        clearInterval(sweep)
        clearInterval(maintenance)
        const closed = new Promise<void>((resolve) => http.close(() => resolve()))
        for (const connection of connections) connection.close(CLOSE_CODES.GOING_AWAY, 'server shutting down')
        // Give peers a moment to complete the closing handshake, then drop whatever is left.
        await new Promise((resolve) => setTimeout(resolve, 200))
        for (const ws of wss.clients) ws.terminate()
        http.closeAllConnections()
        await closed
        wss.close()
        if (db.isOpen) db.close()
      })()
      return closing
    },
  }
}

/** Starts the server from the environment; used by `npm start` and the container. */
export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  let config: Config
  let tls: TlsMaterial | null = null
  try {
    config = loadConfig(env)
    if (config.tls !== null) tls = loadTls(config.tls)
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : `could not load TLS certificate: ${(error as Error).message}`
    process.stderr.write(`spekterm-server: ${message}\n`)
    process.exit(1)
  }
  let db: Database
  try {
    db = openDataDir(config.dataDir)
  } catch (error) {
    process.stderr.write(`spekterm-server: ${(error as Error).message}\n`)
    process.exit(1)
  }
  const server = await startServer(config.port, { db, tls, handoffRatePerHour: config.handoffRatePerHour })
  if (tls === null) {
    defaultLog(`listening on port ${server.port} without TLS; a TLS terminator (reverse proxy) is expected in front`)
  } else {
    defaultLog(`listening on port ${server.port} with TLS (${tls.selfSigned ? 'self-signed' : 'issued'} certificate ${tls.fingerprint})`)
  }
  const stop = (signal: string) => {
    defaultLog(`${signal} received; shutting down`)
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`spekterm-server: shutdown failed: ${String(error)}\n`)
        process.exit(1)
      },
    )
  }
  process.once('SIGTERM', () => stop('SIGTERM'))
  process.once('SIGINT', () => stop('SIGINT'))
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
