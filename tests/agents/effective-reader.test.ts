import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createEffectiveAgentReader } from '../../src/agents/effective-reader.js'
import { createAgentsStore, type AgentsStore } from '../../src/agents/store.js'
import { createGroupsStore, type GroupsStore } from '../../src/groups/store.js'

/**
 * The reader over REAL stores in a temp directory: the wiring both entry
 * points get is the thing under test, so a fake store would only prove the
 * fake behaves.
 */

const AGENT = 'research-bot'
const SERVER = 'postgres'

let journalDir: string
let agents: AgentsStore
let groups: GroupsStore

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-effective-reader-'))
  agents = createAgentsStore({ journalDir })
  groups = createGroupsStore({ journalDir })
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function readerOf(): ReturnType<typeof createEffectiveAgentReader> {
  return createEffectiveAgentReader({ agents, groups })
}

describe('createEffectiveAgentReader', () => {
  test('getAgent expands a grant the agent holds only through a group', async () => {
    // Arrange
    await agents.createAgent(AGENT)
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', SERVER, ['query'])
    await groups.addMember('analytics', AGENT)

    // Act
    const record = await readerOf().getAgent(AGENT)

    // Assert
    expect(record?.grants).toEqual({ [SERVER]: { tools: ['query'] } })
  })

  test('findAgentByToken expands the same way', async () => {
    // Arrange
    const created = await agents.createAgent(AGENT)
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', SERVER, '*')
    await groups.addMember('analytics', AGENT)

    // Act
    const record = await readerOf().findAgentByToken(created.token)

    // Assert
    expect(record?.name).toBe(AGENT)
    expect(record?.grants).toEqual({ [SERVER]: { tools: '*' } })
  })

  test('an agent in no group is passed through as the store returned it', async () => {
    // Arrange
    await agents.createAgent(AGENT)
    await agents.grantServer(AGENT, SERVER, ['read_rows'])

    // Act
    const record = await readerOf().getAgent(AGENT)

    // Assert
    expect(record).toEqual(await agents.getAgent(AGENT))
  })

  test('a personal grant still wins over the group grant for that server', async () => {
    // Arrange
    await agents.createAgent(AGENT)
    await agents.grantServer(AGENT, SERVER, ['read_rows'])
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', SERVER, '*')
    await groups.addMember('analytics', AGENT)

    // Act
    const record = await readerOf().getAgent(AGENT)

    // Assert
    expect(record?.grants).toEqual({ [SERVER]: { tools: ['read_rows'] } })
  })

  test('an unknown name and an unknown token both stay undefined', async () => {
    // Arrange
    const reader = readerOf()

    // Act & Assert
    expect(await reader.getAgent('nobody')).toBeUndefined()
    expect(await reader.findAgentByToken('mcpj_nope')).toBeUndefined()
  })

  test('a revoked agent keeps resolving by name, with its groups expanded', async () => {
    // Arrange
    const created = await agents.createAgent(AGENT)
    await agents.revokeAgent(AGENT)
    await groups.createGroup('analytics')
    await groups.grantServer('analytics', SERVER, '*')
    await groups.addMember('analytics', AGENT)

    // Act
    const byName = await readerOf().getAgent(AGENT)

    // Assert — revocation is `agents/scope.ts`'s call, not this reader's
    expect(byName?.revokedAt).toBeDefined()
    expect(byName?.grants).toEqual({ [SERVER]: { tools: '*' } })
    expect(await readerOf().findAgentByToken(created.token)).toBeUndefined()
  })

  test('a groups read failure propagates instead of narrowing the matrix', async () => {
    // Arrange
    await agents.createAgent(AGENT)
    const failure = new Error('groups store exploded')
    const reader = createEffectiveAgentReader({
      agents,
      groups: { groupsOf: () => Promise.reject(failure) },
    })

    // Act & Assert
    await expect(reader.getAgent(AGENT)).rejects.toBe(failure)
    await expect(reader.findAgentByToken('whatever')).resolves.toBeUndefined()
  })
})
