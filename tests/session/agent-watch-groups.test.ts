import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createEffectiveAgentReader } from '../../src/agents/effective-reader.js'
import type { AgentRecord } from '../../src/agents/schema.js'
import { createAgentsStore, type AgentsStore } from '../../src/agents/store.js'
import { createGroupsStore, type GroupsStore } from '../../src/groups/store.js'
import { grantsHashOf } from '../../src/policy/provenance.js'
import { startAgentWatch, type AgentWatch } from '../../src/session/agent-watch.js'

/**
 * The session watch reading through the effective-agent reader (M5.5 п.2,
 * G2/G5): membership edits reach a LIVE session on the next poll, exactly the
 * way personal grant edits already did, and the fingerprint the gate stamps on
 * decision records follows the EXPANDED matrix.
 *
 * Real stores in a temp directory on purpose: what is under test is the wiring
 * `connect`/`serve` install, and a fake reader would only prove the fake.
 */

const AGENT = 'research-bot'
const SERVER = 'testsrv'
const GROUP = 'analytics'
const POLL_INTERVAL_MS = 5
/** Generous ceiling for "this was never going to happen"; never a delay that is waited out. */
const OBSERVE_TIMEOUT_MS = 5_000

let journalDir: string
let agents: AgentsStore
let groups: GroupsStore
let watches: AgentWatch[]
let errors: unknown[]

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-watch-groups-'))
  agents = createAgentsStore({ journalDir })
  groups = createGroupsStore({ journalDir })
  watches = []
  errors = []
})

afterEach(async () => {
  for (const watch of watches) watch.stop()
  await rm(journalDir, { recursive: true, force: true })
})

async function waitUntil(describeWhat: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + OBSERVE_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${describeWhat}`)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

/** The agent as the traffic path sees it: personal grants widened by its groups. */
function reader(): ReturnType<typeof createEffectiveAgentReader> {
  return createEffectiveAgentReader({ agents, groups })
}

async function effectiveRecord(): Promise<AgentRecord> {
  const record = await reader().getAgent(AGENT)
  if (record === undefined) throw new Error('the test agent disappeared')
  return record
}

function startWatch(record: AgentRecord, onRevoked: () => void = () => undefined): AgentWatch {
  const watch = startAgentWatch({
    record,
    serverName: SERVER,
    store: reader(),
    pollIntervalMs: POLL_INTERVAL_MS,
    onRevoked,
    onError: (error) => errors.push(error),
  })
  watches.push(watch)
  watch.start()
  return watch
}

/** An agent whose only path to `SERVER` is its membership in `GROUP`. */
async function seedGroupOnlyAgent(tools: readonly string[] | '*' = ['echo']): Promise<void> {
  await agents.createAgent(AGENT)
  await groups.createGroup(GROUP)
  await groups.grantServer(GROUP, SERVER, tools)
  await groups.addMember(GROUP, AGENT)
}

describe('agent watch over group-derived grants', () => {
  test('an agent granted only through a group opens with the grant live', async () => {
    // Arrange
    await seedGroupOnlyAgent()
    const record = await effectiveRecord()

    // Act
    const watch = startWatch(record)

    // Assert
    expect(watch.scope.isGranted('echo')).toBe(true)
    expect(watch.scope.isGranted('risky_tool')).toBe(false)
    expect(errors).toEqual([])
  })

  test('the stamped fingerprint is the EXPANDED matrix, not the empty personal one', async () => {
    // Arrange
    await seedGroupOnlyAgent()
    const personal = await agents.getAgent(AGENT)
    const record = await effectiveRecord()

    // Act
    const watch = startWatch(record)

    // Assert — G5: provenance describes what the agent could actually do
    expect(personal?.grants).toEqual({})
    expect(watch.scope.grantsHash?.()).toBe(grantsHashOf({ [SERVER]: { tools: ['echo'] } }))
    expect(watch.scope.grantsHash?.()).not.toBe(grantsHashOf(personal?.grants ?? {}))
  })

  test('editing the group grant moves the fingerprint on the next poll', async () => {
    // Arrange
    await seedGroupOnlyAgent()
    const watch = startWatch(await effectiveRecord())
    const before = watch.scope.grantsHash?.()

    // Act
    await groups.grantServer(GROUP, SERVER, ['echo', 'summarize'])

    // Assert
    await waitUntil('the widened group grant to reach the scope', () =>
      watch.scope.isGranted('summarize'),
    )
    expect(watch.scope.grantsHash?.()).not.toBe(before)
    expect(watch.scope.grantsHash?.()).toBe(
      grantsHashOf({ [SERVER]: { tools: ['echo', 'summarize'] } }),
    )
    expect(errors).toEqual([])
  })

  test('removing the server from the group revokes the live session', async () => {
    // Arrange
    await seedGroupOnlyAgent()
    let isRevoked = false
    startWatch(await effectiveRecord(), () => {
      isRevoked = true
    })

    // Act
    await groups.ungrantServer(GROUP, SERVER)

    // Assert
    await waitUntil('the watch to revoke', () => isRevoked)
    expect(errors).toEqual([])
  })

  test('removing the agent from the group revokes the live session', async () => {
    // Arrange
    await seedGroupOnlyAgent()
    let isRevoked = false
    startWatch(await effectiveRecord(), () => {
      isRevoked = true
    })

    // Act
    await groups.removeMember(GROUP, AGENT)

    // Assert
    await waitUntil('the watch to revoke', () => isRevoked)
  })

  test('a personal grant survives a group edit that would have narrowed it', async () => {
    // Arrange
    await agents.createAgent(AGENT)
    await agents.grantServer(AGENT, SERVER, ['echo'])
    await groups.createGroup(GROUP)
    await groups.grantServer(GROUP, SERVER, '*')
    await groups.addMember(GROUP, AGENT)
    const watch = startWatch(await effectiveRecord())

    // Assert — G2: the personal grant takes the server whole
    expect(watch.scope.isGranted('echo')).toBe(true)
    expect(watch.scope.isGranted('risky_tool')).toBe(false)
  })

  test('a failing groups read keeps the last known-good scope instead of narrowing it', async () => {
    // Arrange
    await seedGroupOnlyAgent()
    const record = await effectiveRecord()
    const failure = new Error('groups store exploded')
    const watch = startAgentWatch({
      record,
      serverName: SERVER,
      store: createEffectiveAgentReader({
        agents,
        groups: { groupsOf: () => Promise.reject(failure) },
      }),
      pollIntervalMs: POLL_INTERVAL_MS,
      onRevoked: () => errors.push(new Error('unexpected revocation')),
      onError: (error) => errors.push(error),
    })
    watches.push(watch)

    // Act
    watch.start()
    await waitUntil('the poll error to be reported', () => errors.length > 0)

    // Assert — the error surfaces, the session keeps its grant
    expect(errors[0]).toBe(failure)
    expect(watch.scope.isGranted('echo')).toBe(true)
  })
})
