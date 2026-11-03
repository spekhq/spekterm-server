/** Test certificates generated with the openssl command line. */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

function openssl(args: string[], cwd: string): void {
  execFileSync('openssl', args, { cwd, stdio: 'pipe' })
}

const EC = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes']

/** A self-signed certificate for `localhost`. */
export function makeSelfSigned(dir: string, name = 'self'): { certPath: string; keyPath: string } {
  const certPath = join(dir, `${name}.crt`)
  const keyPath = join(dir, `${name}.key`)
  openssl(
    ['req', '-x509', ...EC, '-keyout', keyPath, '-out', certPath, '-days', '30', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
    dir,
  )
  return { certPath, keyPath }
}

/**
 * A leaf issued by a private CA. `certPath` holds the chain (leaf, then CA). With `sameName`, the leaf's
 * subject equals the CA's, so a check on names alone would wrongly call it self-signed.
 */
export function makeCaIssued(dir: string, sameName = false): { certPath: string; keyPath: string; caPath: string } {
  const caPath = join(dir, 'ca.crt')
  const caKey = join(dir, 'ca.key')
  openssl(['req', '-x509', ...EC, '-keyout', caKey, '-out', caPath, '-days', '30', '-subj', '/CN=Test CA'], dir)
  const keyPath = join(dir, 'leaf.key')
  const csr = join(dir, 'leaf.csr')
  const leafPath = join(dir, 'leaf.crt')
  openssl(['req', '-new', ...EC, '-keyout', keyPath, '-out', csr, '-subj', sameName ? '/CN=Test CA' : '/CN=localhost'], dir)
  const ext = join(dir, 'leaf.ext')
  writeFileSync(ext, 'subjectAltName=DNS:localhost,IP:127.0.0.1\n')
  openssl(['x509', '-req', '-in', csr, '-CA', caPath, '-CAkey', caKey, '-CAcreateserial', '-out', leafPath,
    '-days', '30', '-extfile', ext], dir)
  const certPath = join(dir, 'chain.crt')
  execFileSync('sh', ['-c', `cat leaf.crt ca.crt > chain.crt`], { cwd: dir })
  return { certPath, keyPath, caPath }
}
