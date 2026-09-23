import { describe, expect, test } from 'vitest'
import { BRIDGE_POOL_PATH } from '../../../src/bridge/constants.js'
import { parseRoute } from '../../../src/transport/http/routes.js'
import {
  POOL_ROUTE_PATH,
  POOL_ROUTE_TARGET,
  ROUTE_NAME_PATTERN,
} from '../../../src/transport/http/server-constants.js'

/**
 * The agent pool route (ADR-0015 phase 3). The per-server shape of M3 keeps
 * its own unit coverage in `server-hardening.test.ts`; what is new here is
 * the second arm of the union and the two invariants that hold it in place.
 */

describe('pool route', () => {
  test.each(['POST', 'GET', 'DELETE'])('parses %s /mcp as a pool route', (method) => {
    // The pool address carries no agent name: the bearer token names the
    // agent (PE5), so nothing in the path could be compared against it.
    expect(parseRoute(method, POOL_ROUTE_PATH)).toEqual({ kind: 'pool', method })
  })

  test('ignores the query string on the pool path too', () => {
    expect(parseRoute('POST', `${POOL_ROUTE_PATH}?session=1`)).toEqual({
      kind: 'pool',
      method: 'POST',
    })
  })

  test.each([
    ['trailing slash', '/mcp/'],
    ['sub-path', '/mcp/tools'],
    ['different case', '/MCP'],
    ['prefix only', '/mc'],
    ['longer name', '/mcpx'],
    ['nested under the per-server tree', '/agents/bot/servers/mcp/mcp'],
  ])('refuses %s', (_label, url) => {
    expect(parseRoute('POST', url)).toBeNull()
  })

  test('refuses a method the endpoint does not serve', () => {
    expect(parseRoute('PUT', POOL_ROUTE_PATH)).toBeNull()
  })

  test('serves the very path the bridge dials', () => {
    // `connect --url <base>` appends `BRIDGE_POOL_PATH` when the operator
    // gave no path (PE5). If the two ever drift, every bridge gets a 404 and
    // the only symptom is "the pool does not exist".
    expect(POOL_ROUTE_PATH).toBe(BRIDGE_POOL_PATH)
  })

  test('the pool target name can never collide with a registry server', () => {
    // A leading `_` is unrepresentable in the route name pattern, so no
    // per-server address can ever produce this `serverName` — the same
    // construction that keeps `plane_probe` out of the server namespace.
    expect(ROUTE_NAME_PATTERN.test(POOL_ROUTE_TARGET)).toBe(false)
  })
})
