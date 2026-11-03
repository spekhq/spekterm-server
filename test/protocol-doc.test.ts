/** Holds `docs/protocol.md` and the server to the same operations, error codes and close codes. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ERROR_CODES, PRE_AUTH_ERROR_CODES } from '../src/errors.ts'
import { CLOSE_CODES, EVENT_KINDS, OPERATIONS } from '../src/protocol.ts'

const DOC = readFileSync(new URL('../docs/protocol.md', import.meta.url), 'utf8')

/** The text of the section whose heading line is exactly `heading`, up to the next heading of that level or higher. */
function section(heading: string): string {
  const level = /^#+/.exec(heading)![0].length
  const start = DOC.indexOf(`\n${heading}\n`)
  assert.notEqual(start, -1, `docs/protocol.md has no "${heading}" section`)
  const rest = DOC.slice(start + heading.length + 2)
  const end = rest.search(new RegExp(`^#{1,${level}} `, 'm'))
  return end === -1 ? rest : rest.slice(0, end)
}

function diff(label: string, documented: Iterable<string | number>, defined: Iterable<string | number>): void {
  const doc = new Set([...documented].map(String))
  const code = new Set([...defined].map(String))
  const missing = [...code].filter((x) => !doc.has(x))
  const extra = [...doc].filter((x) => !code.has(x))
  assert.deepEqual({ missingFromDocument: missing, notInServer: extra }, { missingFromDocument: [], notInServer: [] }, label)
}

test('operations: document and registry agree', () => {
  const documented = [...section('## 5. Operations').matchAll(/^### `([^`]+)`$/gm)].map((m) => m[1]!)
  diff('operations', documented, Object.keys(OPERATIONS))
})

test('error codes: document and server agree', () => {
  const documented = [...section('### Error codes').matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]!)
  diff('error codes', documented, ERROR_CODES)
})

test('close codes: document and server agree', () => {
  const documented = [...section('### Close codes').matchAll(/^\| (\d{4}) \|/gm)].map((m) => m[1]!)
  diff('close codes', documented, Object.values(CLOSE_CODES))
})

test('event kinds: document and server agree', () => {
  const documented = [...section('## 10. Events').matchAll(/^### `([^`]+)`$/gm)].map((m) => m[1]!)
  diff('event kinds', documented, EVENT_KINDS)
})

test('every pre-authentication error has a client action', () => {
  const table = section('## 4. Before authentication')
  for (const code of PRE_AUTH_ERROR_CODES) {
    assert.match(table, new RegExp(`^\\|[^\\n]*\`${code}\``, 'm'), `no client action for ${code}`)
  }
})
