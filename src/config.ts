/** Configuration read from the environment (`server-operation` spec). */
export interface Config {
  port: number
  dataDir: string
  /** `wss://host[:port]`, no path, no trailing slash; null when not set. */
  publicUrl: string | null
  tls: { certPath: string; keyPath: string } | null
}

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
  }
}
