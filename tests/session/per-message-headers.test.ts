import { describe, expect, test } from 'vitest'
import {
  perMessageHeadersFor,
  perMessageHeadersOptionOf,
} from '../../src/session/per-message-headers.js'

/**
 * The one place both `connect` and `serve` decide whether an HTTP upstream
 * gets the SEP-2243 per-message header mirror. The three protocol values are
 * pinned here because the two commands used to disagree about `'auto'`
 * (connect omitted the headers, serve sent them), which made every call
 * against a stateless server answering an `auto` record fail with -32020.
 */

const TOOLS_CALL = Buffer.from(
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } }),
  'utf8',
)

describe('perMessageHeadersFor', () => {
  test("'stateless' gets the header mirror", () => {
    const hook = perMessageHeadersFor('stateless')

    expect(hook).toBeDefined()
    expect(hook?.(TOOLS_CALL)).toMatchObject({ 'Mcp-Method': 'tools/call', 'Mcp-Name': 'echo' })
  })

  test("'auto' gets the header mirror too: it may turn out to be stateless", () => {
    const hook = perMessageHeadersFor('auto')

    expect(hook).toBeDefined()
    expect(hook?.(TOOLS_CALL)).toMatchObject({ 'Mcp-Method': 'tools/call', 'Mcp-Name': 'echo' })
  })

  test("only an explicitly pinned 'sessionful' record omits the mirror", () => {
    expect(perMessageHeadersFor('sessionful')).toBeUndefined()
  })

  test('auto and stateless resolve to the very same hook', () => {
    expect(perMessageHeadersFor('auto')).toBe(perMessageHeadersFor('stateless'))
  })
})

describe('perMessageHeadersOptionOf', () => {
  test('carries the hook for auto and stateless, and is empty for sessionful', () => {
    expect(perMessageHeadersOptionOf('auto')).toEqual({
      perMessageHeaders: perMessageHeadersFor('auto'),
    })
    expect(perMessageHeadersOptionOf('stateless')).toEqual({
      perMessageHeaders: perMessageHeadersFor('stateless'),
    })
    // The key is ABSENT, not undefined: `exactOptionalPropertyTypes` forbids
    // handing an explicit `undefined` to the client's optional option.
    expect(Object.keys(perMessageHeadersOptionOf('sessionful'))).toEqual([])
  })
})
