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

/**
 * A vault value of no recognisable shape: no prefix, no key-value context,
 * nothing a pattern could match. Only the known-secrets registry can catch it.
 */
const BARE_MARKER = 'BAREMARKER'
const BARE_SECRET = `Zk4mQp7RtY2w${BARE_MARKER}nB3sCd6fGh1jKl0a`

function build(classified: ClassifiedMessage): string {
  const builder = createRecordBuilder('session-leak', { now: () => 1_000 })
  return JSON.stringify(builder.buildRecord(classified, 'client→server'))
}

/** Same, for a builder that was told which exact values the plane injected. */
function buildKnown(classified: ClassifiedMessage): string {
  const builder = createRecordBuilder('session-leak', {
    now: () => 1_000,
    knownSecrets: [BARE_SECRET],
  })
  return JSON.stringify(builder.buildRecord(classified, 'server→client'))
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

/**
 * The compliance half of the guarantee: the journal must also redact the
 * values the control plane itself injected into the upstream (vault-resolved
 * env/header material). Those have no recognisable shape, so the record
 * builder is told the exact strings — and every carrier must honor them.
 */
describe('known-secret leak regression: a vault value of arbitrary shape', () => {
  test('baseline: without registration a bare vault value DOES reach the journal', () => {
    const record = createRecordBuilder('session-leak', { now: () => 1_000 }).buildStderrRecord(
      `server booted with ${BARE_SECRET}`,
    )

    expect(JSON.stringify(record)).toContain(BARE_MARKER)
  })

  test('carrier 7: an echoed bare value in a stderr line never survives', () => {
    const builder = createRecordBuilder('session-leak', {
      now: () => 1_000,
      knownSecrets: [BARE_SECRET],
    })

    const record = builder.buildStderrRecord(`server booted with ${BARE_SECRET}`)

    expect(JSON.stringify(record)).not.toContain(BARE_MARKER)
  })

  test('carrier 8: a bare value under an innocent key in result.content[].text never survives', () => {
    const raw = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ note: `echoed ${BARE_SECRET}` }) }],
      },
    })

    expect(buildKnown({ kind: 'response', id: 1, isError: false, raw })).not.toContain(BARE_MARKER)
  })

  test('carrier 9: a bare value in a truncated, unparseable line never survives', () => {
    const raw = `{"jsonrpc":"2.0","id":1,"result":{"note":"${BARE_SECRET}"`

    expect(buildKnown({ kind: 'invalid', raw, reason: 'not valid JSON' })).not.toContain(BARE_MARKER)
  })

  test('carrier 10: a bare value in a plain structural string field never survives', () => {
    const raw = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { greeting: `hello ${BARE_SECRET}` },
    })

    expect(buildKnown({ kind: 'response', id: 1, isError: false, raw })).not.toContain(BARE_MARKER)
  })

  test('carrier 11: a bare value smuggled through the method name never survives', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: `notify/${BARE_SECRET}` })

    expect(
      buildKnown({ kind: 'request', id: 1, method: `notify/${BARE_SECRET}`, raw }),
    ).not.toContain(BARE_MARKER)
  })

  test('carrier 12: a bare value smuggled through a string JSON-RPC id never survives', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: BARE_SECRET, result: {} })

    expect(buildKnown({ kind: 'response', id: BARE_SECRET, isError: false, raw })).not.toContain(
      BARE_MARKER,
    )
  })

  test('values registered after construction apply to later records too', () => {
    const builder = createRecordBuilder('session-leak', { now: () => 1_000 })

    builder.registerKnownSecrets([BARE_SECRET])
    const record = builder.buildStderrRecord(`late registration ${BARE_SECRET}`)

    expect(JSON.stringify(record)).not.toContain(BARE_MARKER)
  })
})
