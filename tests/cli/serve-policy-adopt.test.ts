import { writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, test } from 'vitest'
import { POLICY_RECHECK_MIN_MS } from '../../src/policy/constants.js'
import {
  INITIALIZE_BODY,
  POLICY_SERVER,
  addStdioServer,
  disposeServeFixtures,
  sleep,
  startServe,
  toolCallBody,
  waitUntil,
} from './serve-harness.js'

/**
 * User-journey smoke 2026-09-18, M1. `setup` starts `serve` before any
 * `policy.json` exists; the operator writes one afterwards. The front used to
 * stay journaling-only until a restart, while the admin UI already showed the
 * new file's hash. Proven here against the real front: a session that is
 * ALREADY OPEN has its very next call decided under the file that appeared.
 */

afterEach(disposeServeFixtures)

async function openSession(fixture: Awaited<ReturnType<typeof startServe>>): Promise<Record<string, string>> {
  const init = await fixture.post(INITIALIZE_BODY)
  expect(init.status).toBe(200)
  return { 'mcp-session-id': init.headers.get('mcp-session-id') ?? '' }
}

describe('serve started with no policy file', () => {
  test('adopts a policy.json that appears, for a session that is already open', async () => {
    const fixture = await startServe({ grant: '*', withoutPolicy: true })
    await addStdioServer(fixture, POLICY_SERVER)
    expect(fixture.io.errText()).toContain('no policy file found')
    const session = await openSession(fixture)

    const before = await fixture.post(toolCallBody(2, 'echo'), session)
    expect(await before.json()).toMatchObject({ id: 2, result: {} })

    await writeFile(fixture.policyPath, JSON.stringify({ version: 1, defaultDecision: 'deny' }), 'utf8')
    await sleep(POLICY_RECHECK_MIN_MS + 50)

    const after = await fixture.post(toolCallBody(3, 'echo'), session)
    expect(await after.json()).toMatchObject({ id: 3, error: { code: -32001 } })
    expect(fixture.io.errText()).toContain(`policy adopted: ${fixture.policyPath}`)
  })

  test('says so, and keeps journaling only, when the file that appears is broken', async () => {
    const fixture = await startServe({ grant: '*', withoutPolicy: true })
    await addStdioServer(fixture, POLICY_SERVER)
    const session = await openSession(fixture)

    await writeFile(fixture.policyPath, '{ not json', 'utf8')
    await sleep(POLICY_RECHECK_MIN_MS + 50)
    const call = await fixture.post(toolCallBody(2, 'echo'), session)

    expect(await call.json()).toMatchObject({ id: 2, result: {} })
    await waitUntil(() => fixture.io.errText().includes('policy file not adopted'), 'the rejection line')
    expect(fixture.io.errText()).toContain('still journaling only')
  })
})
