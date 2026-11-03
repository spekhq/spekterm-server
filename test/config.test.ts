import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, loadConfig } from '../src/config.ts'

test('defaults', () => {
  assert.deepEqual(loadConfig({}), { port: 8080, dataDir: '/data', publicUrl: null, tls: null, handoffRatePerHour: 30 })
})

test('all variables', () => {
  const config = loadConfig({
    PORT: '9000',
    DATA_DIR: '/srv/team',
    PUBLIC_URL: 'wss://team.example.com:8443/',
    TLS_CERT: '/c.pem',
    TLS_KEY: '/k.pem',
    HANDOFF_RATE_PER_HOUR: '120',
  })
  assert.deepEqual(config, {
    port: 9000,
    dataDir: '/srv/team',
    publicUrl: 'wss://team.example.com:8443',
    tls: { certPath: '/c.pem', keyPath: '/k.pem' },
    handoffRatePerHour: 120,
  })
})

test('a lone TLS variable names the missing one', () => {
  assert.throws(() => loadConfig({ TLS_CERT: '/c.pem' }), (e: unknown) => e instanceof ConfigError && e.variable === 'TLS_KEY')
  assert.throws(() => loadConfig({ TLS_KEY: '/k.pem' }), (e: unknown) => e instanceof ConfigError && e.variable === 'TLS_CERT')
})

test('public address must be wss', () => {
  assert.throws(() => loadConfig({ PUBLIC_URL: 'http://team.example.com' }), /must start with wss:\/\//)
  assert.throws(() => loadConfig({ PUBLIC_URL: 'ws://team.example.com' }), /must start with wss:\/\//)
})

test('public address must not carry a path', () => {
  assert.throws(() => loadConfig({ PUBLIC_URL: 'wss://example.com/team' }), /must not carry a path/)
})

test('trailing slash is dropped', () => {
  assert.equal(loadConfig({ PUBLIC_URL: 'wss://example.com/' }).publicUrl, 'wss://example.com')
})

test('invalid port', () => {
  assert.throws(() => loadConfig({ PORT: 'eighty' }), (e: unknown) => e instanceof ConfigError && e.variable === 'PORT')
  assert.throws(() => loadConfig({ PORT: '70000' }), (e: unknown) => e instanceof ConfigError && e.variable === 'PORT')
})

test('invalid handoff rate names the variable', () => {
  for (const bad of ['0', 'many', '10001', '-1', '1.5']) {
    assert.throws(() => loadConfig({ HANDOFF_RATE_PER_HOUR: bad }), (e: unknown) => e instanceof ConfigError && e.variable === 'HANDOFF_RATE_PER_HOUR')
  }
  assert.equal(loadConfig({ HANDOFF_RATE_PER_HOUR: '10000' }).handoffRatePerHour, 10000)
})
