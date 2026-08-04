import { describe, expect, test } from 'vitest'
import { createRecordBuilder } from '../../src/journal/record.js'
import type { ClassifiedMessage } from '../../src/protocol/classify.js'

/**
 * Cross-carrier leak regression suite.
 *
 * A single marker secret is pushed through every path a payload can take
 * into a journal record. The invariant under test is deliberately blunt:
 * the serialized record must not contain the marker substring, no matter
 * which carrier smuggled it in. If any of these fail, a real secret is
 * reaching disk.
 */

const MARKER = 'LEAKMARKER'
const SECRET = `sk-live-${MARKER}123`

function build(classified: ClassifiedMessage): string {
  const builder = createRecordBuilder('session-leak', { now: () => 1_000 })
  return JSON.stringify(builder.buildRecord(classified, 'client→server'))
}

describe('secret leak regression across all record carriers', () => {
  test('carrier 1: structural key inside a valid JSON-RPC request never survives', () => {
    const raw = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search', arguments: { api_key: SECRET } },
    })

    const serialized = build({ kind: 'request', id: 1, method: 'tools/call', raw })

    expect(serialized).not.toContain(MARKER)
  })

  test('carrier 2: JSON-encoded secret inside result.content[0].text never survives', () => {
    const raw = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ api_key: SECRET }) }],
      },
    })

    const serialized = build({ kind: 'response', id: 1, isError: false, raw })

    expect(serialized).not.toContain(MARKER)
  })

  test('carrier 3: raw unparseable (truncated) line never survives', () => {
    const raw = `{"jsonrpc":"2.0","id":1,"params":{"api_key":"${SECRET}"`

    const serialized = build({ kind: 'invalid', raw, reason: 'not valid JSON' })

    expect(serialized).not.toContain(MARKER)
  })

  test('carrier 4: stderr line never survives', () => {
    const builder = createRecordBuilder('session-leak', { now: () => 1_000 })

    const record = builder.buildStderrRecord(
      `env: OPENAI_API_KEY=${SECRET} {"password":"${SECRET}"}`,
    )

    expect(JSON.stringify(record)).not.toContain(MARKER)
  })

  test('carrier 5: JSON-RPC batch (classified invalid, valid JSON) never survives', () => {
    const raw = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { token: SECRET } },
    ])

    const serialized = build({ kind: 'invalid', raw, reason: 'batches are not supported' })

    expect(serialized).not.toContain(MARKER)
  })

  test('carrier 6: doubly JSON-encoded secret (one level deeper) never survives', () => {
    const inner = JSON.stringify({ api_key: SECRET })
    const raw = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({ envelope: inner }) }] },
    })

    const serialized = build({ kind: 'response', id: 1, isError: false, raw })

    expect(serialized).not.toContain(MARKER)
  })
})
