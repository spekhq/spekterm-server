/** Configuration read from the environment (`server-operation` spec). */
export interface Config {
  port: number
  dataDir: string
  /** `wss://host[:port]`, no path, no trailing slash; null when not set. */
  publicUrl: string | null
  tls: { certPath: string; keyPath: string } | null
  /** The most handoffs one member may send in any hour. */
  handoffRatePerHour: number
  /** Whether the server relays phones to their desktops (`RELAY`; phone-relay). */
  relay: boolean
  /** The most relay tunnels at once, open or pending. */
  relayMaxTunnels: number
  /** The most KiB per second each direction of a tunnel carries; 0 means no cap. */
  relayKibPerSecond: number
}

/** Defaults measured on a Synology DS218j (phone-relay, design D8). */
export const DEFAULT_RELAY_MAX_TUNNELS = 32
export const DEFAULT_RELAY_KIB_PER_SECOND = 512

export class ConfigError extends Error {
  readonly variable: string
  constructor(variable: string, message: string) {
    super(`${variable}: ${message}`)
    this.variable = variable
  }
}

type Env = Record<string, string | undefined>

function nonEmpty(env: Env, name: string): string | undefined {
  const value = env[name]
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

export function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 8080
  if (!/^\d+$/.test(raw)) throw new ConfigError('PORT', `must be a port number, got "${raw}"`)
  const port = Number(raw)
  if (port < 1 || port > 65535) throw new ConfigError('PORT', `must be between 1 and 65535, got ${port}`)
  return port
}

export function parseRate(raw: string | undefined): number {
  if (raw === undefined) return 30
  if (!/^\d+$/.test(raw)) throw new ConfigError('HANDOFF_RATE_PER_HOUR', `must be a whole number, got "${raw}"`)
  const rate = Number(raw)
  if (rate < 1 || rate > 10000) {
    throw new ConfigError('HANDOFF_RATE_PER_HOUR', `must be between 1 and 10000, got ${rate}`)
  }
  return rate
}

function parseWhole(variable: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw new ConfigError(variable, `must be a whole number, got "${raw}"`)
  const value = Number(raw)
  if (value < min || value > max) throw new ConfigError(variable, `must be between ${min} and ${max}, got ${value}`)
  return value
}

export function parseRelay(raw: string | undefined): boolean {
  if (raw === undefined) return false
  if (raw === 'on') return true
  if (raw === 'off') return false
  throw new ConfigError('RELAY', `must be "on" or "off", got "${raw}"`)
}

export function parsePublicUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError('PUBLIC_URL', `is not a valid address: "${raw}"`)
  }
  if (url.protocol !== 'wss:') {
    throw new ConfigError('PUBLIC_URL', `must start with wss://, got "${raw}"`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigError('PUBLIC_URL', 'must not carry a user name or password')
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new ConfigError('PUBLIC_URL', `must not carry a path, got "${url.pathname}"`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw new ConfigError('PUBLIC_URL', 'must not carry a query or fragment')
  }
  return `wss://${url.host}`
}

export function loadConfig(env: Env = process.env): Config {
  const certPath = nonEmpty(env, 'TLS_CERT')
  const keyPath = nonEmpty(env, 'TLS_KEY')
  if (certPath !== undefined && keyPath === undefined) {
    throw new ConfigError('TLS_KEY', 'must be set when TLS_CERT is set')
  }
  if (keyPath !== undefined && certPath === undefined) {
    throw new ConfigError('TLS_CERT', 'must be set when TLS_KEY is set')
  }
  return {
    port: parsePort(nonEmpty(env, 'PORT')),
    dataDir: nonEmpty(env, 'DATA_DIR') ?? '/data',
    publicUrl: parsePublicUrl(nonEmpty(env, 'PUBLIC_URL')),
    tls: certPath !== undefined && keyPath !== undefined ? { certPath, keyPath } : null,
    handoffRatePerHour: parseRate(nonEmpty(env, 'HANDOFF_RATE_PER_HOUR')),
    relay: parseRelay(nonEmpty(env, 'RELAY')),
    relayMaxTunnels: parseWhole('RELAY_MAX_TUNNELS', nonEmpty(env, 'RELAY_MAX_TUNNELS'), DEFAULT_RELAY_MAX_TUNNELS, 1, 1000),
    relayKibPerSecond: parseWhole('RELAY_KIB_PER_SECOND', nonEmpty(env, 'RELAY_KIB_PER_SECOND'), DEFAULT_RELAY_KIB_PER_SECOND, 0, 1048576),
  }
}
