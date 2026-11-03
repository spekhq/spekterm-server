import { type Database, openDataDir } from '../../src/db.ts'
import { type RunningServer, type ServerOptions, startServer } from '../../src/server.ts'
import { createInvite, join as joinTeam } from '../../src/team.ts'
import { tempDir } from './db.ts'
import { DATABASE_FILE } from '../../src/db.ts'
import { join } from 'node:path'

export const FAST = {
  timings: { authTimeoutMs: 400, refuseDelayMs: 50, pingIntervalMs: 60_000, lastSeenWriteMs: 25_000 },
  sweepIntervalMs: 50,
}

export interface TestServer {
  server: RunningServer
  db: Database
  dir: string
  dbPath: string
  url: string
  logs: string[]
}

export async function testServer(
  t: { after: (fn: () => Promise<void> | void) => void },
  options: Partial<ServerOptions> = {},
): Promise<TestServer> {
  const dir = tempDir(t)
  const db = openDataDir(dir)
  const logs: string[] = []
  const server = await startServer(0, { db, ...FAST, log: (m) => logs.push(m), ...options, timings: { ...FAST.timings, ...options.timings } })
  t.after(() => server.close())
  const scheme = options.tls != null ? 'wss' : 'ws'
  return { server, db, dir, dbPath: join(dir, DATABASE_FILE), url: `${scheme}://127.0.0.1:${server.port}/connect`, logs }
}

/** Creates a member directly in the database and returns its credential. */
export function seedMember(db: Database, handle = 'sam', deviceName = 'home desktop') {
  const invite = createInvite(db, {}, Date.now)
  return joinTeam(db, { code: invite.code, handle, displayName: handle.toUpperCase(), deviceName }, Date.now)
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
