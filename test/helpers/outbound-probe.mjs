// Preloaded with --import into a server or admin process under test: records every outbound socket and
// DNS lookup the process makes into the file named by OUTBOUND_LOG.
import { appendFileSync } from 'node:fs'
import { subscribe } from 'node:diagnostics_channel'
import dns from 'node:dns'
import { createRequire } from 'node:module'

const logFile = process.env.OUTBOUND_LOG
const record = (what) => appendFileSync(logFile, `${process.pid} ${what}\n`)

subscribe('net.client.socket', () => record('net.client.socket'))
subscribe('udp.socket', () => record('udp.socket'))

const require = createRequire(import.meta.url)
const dnsCjs = require('node:dns')
const wrap = (target, name, label) => {
  const original = target[name]
  if (typeof original !== 'function') return
  target[name] = function (...args) {
    record(`${label}.${name}(${String(args[0])})`)
    return original.apply(this, args)
  }
}
const names = ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname',
  'resolveMx', 'resolveNs', 'resolveSrv', 'resolveTxt', 'reverse']
for (const name of names) {
  wrap(dns, name, 'dns')
  wrap(dnsCjs, name, 'dns')
  wrap(dns.promises, name, 'dns.promises')
}
record('probe loaded')
