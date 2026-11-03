import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate, createHash } from 'node:crypto'
import { loadTls } from '../src/tls.ts'
import { makeCaIssued, makeSelfSigned } from './helpers/certs.ts'

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'spekterm-server-tls-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('self-signed certificate is detected and fingerprinted', (t) => {
  const paths = makeSelfSigned(tempDir(t))
  const tls = loadTls(paths)
  assert.equal(tls.selfSigned, true)
  const der = new X509Certificate(readFileSync(paths.certPath)).raw
  assert.equal(tls.fingerprint, createHash('sha256').update(der).digest('hex').toUpperCase())
  assert.match(tls.fingerprint, /^[0-9A-F]{64}$/)
})

test('CA-issued leaf is not self-signed; fingerprint is of the leaf', (t) => {
  const paths = makeCaIssued(tempDir(t))
  const tls = loadTls(paths)
  assert.equal(tls.selfSigned, false)
  const leafDer = new X509Certificate(readFileSync(join(paths.certPath, '..', 'leaf.crt'))).raw
  assert.equal(tls.fingerprint, createHash('sha256').update(leafDer).digest('hex').toUpperCase())
})

test('CA-issued leaf whose subject equals its issuer is not self-signed', (t) => {
  const tls = loadTls(makeCaIssued(tempDir(t), true))
  assert.equal(tls.selfSigned, false)
})
