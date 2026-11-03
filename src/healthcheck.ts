/**
 * Container health probe: exits 0 when `/healthz` on this container answers 200. Speaks HTTPS without
 * verifying the certificate when the server serves TLS itself, since it only checks liveness on localhost.
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const port = Number(process.env.PORT ?? '8080')
const tls = (process.env.TLS_CERT ?? '').trim() !== ''
const request = tls ? httpsRequest : httpRequest

const req = request(
  { host: '127.0.0.1', port, path: '/healthz', timeout: 4000, rejectUnauthorized: false },
  (res) => {
    res.resume()
    process.exit(res.statusCode === 200 ? 0 : 1)
  },
)
req.on('timeout', () => req.destroy(new Error('timed out')))
req.on('error', (error) => {
  process.stderr.write(`health check failed: ${error.message}\n`)
  process.exit(1)
})
req.end()
