/** The server's own TLS certificate: loading, self-signed detection, fingerprint (design D6). */
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'

export interface TlsMaterial {
  /** The PEM certificate chain, leaf first. */
  cert: Buffer
  key: Buffer
  /** SHA-256 of the leaf certificate in DER, 64 upper-case hex digits, no separators. */
  fingerprint: string
  /** The leaf names itself as issuer and its signature verifies with its own public key. */
  selfSigned: boolean
}

export function fingerprintOf(cert: X509Certificate): string {
  return cert.fingerprint256.replaceAll(':', '').toUpperCase()
}

export function isSelfSigned(cert: X509Certificate): boolean {
  return cert.checkIssued(cert) && cert.verify(cert.publicKey)
}

export function loadTls(paths: { certPath: string; keyPath: string }): TlsMaterial {
  const cert = readFileSync(paths.certPath)
  const key = readFileSync(paths.keyPath)
  const leaf = new X509Certificate(cert)
  return { cert, key, fingerprint: fingerprintOf(leaf), selfSigned: isSelfSigned(leaf) }
}
