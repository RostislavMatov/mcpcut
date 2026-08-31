import { afterEach, describe, expect, test } from 'vitest'
import { createGroupsStore } from '../../src/groups/store.js'
import {
  AGENT,
  addStdioServer,
  disposeServeFixtures,
  INITIALIZE_BODY,
  POLICY_SERVER,
  SERVER,
  startServe,
  toolCallBody,
  type ServeFixture,
} from './serve-harness.js'

/**
 * The HTTP entry point admitting an agent whose only path to the server is a
 * group membership (M5.5 п.2, G2). Both reads `serve` performs on the traffic
 * path go through the effective-agent reader — the front's token check and
 * the session factory's re-read — and only a real run over the socket proves
 * both were rewired.
 */

const GROUP = 'analytics'

afterEach(async () => {
  await disposeServeFixtures()
})

/** Grants `SERVER` to `AGENT` through a group, leaving its personal matrix empty. */
async function grantThroughGroup(
  fixture: ServeFixture,
  tools: readonly string[] | '*',
): Promise<void> {
  const groups = createGroupsStore({ journalDir: fixture.journalDir })
  await groups.createGroup(GROUP)
  await groups.grantServer(GROUP, SERVER, tools)
  await groups.addMember(GROUP, AGENT)
}

describe('runServe: grants inherited from a group', () => {
  test('an agent granted only through a group opens a session and calls its tools', async () => {
    // Arrange — `startServe()` with no `grant` creates the agent with none
    const fixture = await startServe()
    await addStdioServer(fixture, POLICY_SERVER)
    await grantThroughGroup(fixture, ['echo'])

    // Act
    const init = await fixture.post(INITIALIZE_BODY)
    const sessionId = init.headers.get('mcp-session-id')

    // Assert
    expect(init.status).toBe(200)
    expect(sessionId).toBeTruthy()
    const call = await fixture.post(toolCallBody(2, 'echo'), { 'mcp-session-id': sessionId as string })
    expect(call.status).toBe(200)
    expect(await call.json()).not.toHaveProperty('error')

    // And the group grant is a grant, not a bypass:
    const denied = await fixture.post(toolCallBody(3, 'risky_tool'), {
      'mcp-session-id': sessionId as string,
    })
    expect((await denied.json()) as { error?: unknown }).toHaveProperty('error')
  })

  test('membership in a group that does not grant this server changes nothing', async () => {
    // Arrange
    const fixture = await startServe()
    await addStdioServer(fixture, POLICY_SERVER)
    const groups = createGroupsStore({ journalDir: fixture.journalDir })
    await groups.createGroup(GROUP)
    await groups.grantServer(GROUP, 'other-server', '*')
    await groups.addMember(GROUP, AGENT)

    // Act
    const response = await fixture.post(INITIALIZE_BODY)

    // Assert — the unchanged no-grant refusal
    expect(response.status).toBe(400)
    expect(await response.json()).toHaveProperty('error')
  })
})
