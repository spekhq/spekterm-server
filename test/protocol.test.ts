import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProtocolError } from '../src/errors.ts'
import { OPERATIONS, authenticatedOperations, negotiate, parseFrame } from '../src/protocol.ts'

test('parseFrame accepts a request and defaults p', () => {
  assert.deepEqual(parseFrame('{"t":"req","id":7,"m":"hello"}'), { ok: true, request: { id: 7, m: 'hello', p: {} } })
  assert.deepEqual(parseFrame('{"t":"req","id":"a","m":"x","p":{"k":1},"extra":true}'), {
    ok: true,
    request: { id: 'a', m: 'x', p: { k: 1 } },
  })
})

test('parseFrame reports the id when one could be read', () => {
  assert.deepEqual(parseFrame('hello'), { ok: false, id: null })
  assert.deepEqual(parseFrame('[1]'), { ok: false, id: null })
  assert.deepEqual(parseFrame('{"t":"res","id":3,"m":"x"}'), { ok: false, id: 3 })
  assert.deepEqual(parseFrame('{"t":"req","id":4}'), { ok: false, id: 4 })
  assert.deepEqual(parseFrame('{"t":"req","id":5,"m":"x","p":[]}'), { ok: false, id: 5 })
  assert.deepEqual(parseFrame('{"t":"req","id":{},"m":"x"}'), { ok: false, id: null })
})

test('negotiate picks the highest common version', () => {
  assert.equal(negotiate([1, 2]), 1)
  assert.equal(negotiate([1]), 1)
})

test('negotiate refuses with the supported list', () => {
  assert.throws(
    () => negotiate([2]),
    (e: unknown) => e instanceof ProtocolError && e.code === 'UNSUPPORTED_VERSION' && JSON.stringify(e.detail) === '{"supported":[1]}',
  )
})

test('negotiate needs a list of numbers', () => {
  for (const bad of [undefined, 1, [], ['1'], [1.5]]) {
    assert.throws(() => negotiate(bad), (e: unknown) => e instanceof ProtocolError && e.code === 'BAD_PARAMS' && e.detail?.field === 'protocol')
  }
})

test('registry: pre-authentication and authenticated operations', () => {
  assert.deepEqual(
    Object.entries(OPERATIONS).filter(([, o]) => o.auth === 'none').map(([n]) => n).sort(),
    ['hello', 'invite.inspect', 'join'],
  )
  assert.deepEqual(authenticatedOperations(), ['device.leave', 'device.rename', 'handoff.received', 'handoff.send', 'handoff.sync', 'handoff.update', 'team.members'])
})
