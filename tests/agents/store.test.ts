import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { AGENTS_FILE_NAME } from '../../src/agents/constants.js'
import {
  AgentExistsError,
  AgentNotFoundError,
  createAgentsStore,
  InvalidAgentNameError,
  InvalidServerNameError,
  InvalidToolPatternError,
  type AgentsStore,
} from '../../src/agents/store.js'

let journalDir: string
let store: AgentsStore

const FIXED_NOW = new Date('2026-08-05T12:00:00.000Z')
const LATER = new Date('2026-08-05T13:00:00.000Z')

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-agents-store-'))
  store = createAgentsStore({ journalDir, clock: () => FIXED_NOW })
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

describe('createAgent', () => {
  test('returns the record plus a one-time plaintext token; record stores only the hash', async () => {
    // Act
    const { agent, token } = await store.createAgent('research-bot')

    // Assert
    expect(agent.name).toBe('research-bot')
    expect(agent.createdAt).toBe(FIXED_NOW.toISOString())
    expect(agent.revokedAt).toBeUndefined()
    expect(agent.grants).toEqual({})
    expect(token.startsWith('mcpj_')).toBe(true)
    expect(agent.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(agent.tokenHash).not.toContain(token)
  })

  test('persists to <journalDir>/agents.json with 0600 permissions', async () => {
    await store.createAgent('research-bot')

    const filePath = join(journalDir, AGENTS_FILE_NAME)
    const fileStat = await stat(filePath)

    expect(fileStat.mode & 0o777).toBe(0o600)
  })

  test('duplicate name → AgentExistsError, first record untouched', async () => {
    const { agent: first } = await store.createAgent('research-bot')

    await expect(store.createAgent('research-bot')).rejects.toBeInstanceOf(AgentExistsError)
    expect(await store.getAgent('research-bot')).toEqual(first)
  })

  test.each(['Research-Bot', '-bad', '', 'x'.repeat(65), 'constructor', 'prototype'])(
    'invalid or reserved name %j → InvalidAgentNameError',
    async (name) => {
      await expect(store.createAgent(name)).rejects.toBeInstanceOf(InvalidAgentNameError)
    },
  )
})

describe('revokeAgent', () => {
  test('sets revokedAt from the injected clock', async () => {
    await store.createAgent('research-bot')
    const laterStore = createAgentsStore({ journalDir, clock: () => LATER })

    const revoked = await laterStore.revokeAgent('research-bot')

    expect(revoked.revokedAt).toBe(LATER.toISOString())
  })

  test('is idempotent: a second revoke succeeds and keeps the ORIGINAL revocation date', async () => {
    await store.createAgent('research-bot')
    const first = await store.revokeAgent('research-bot')

    const laterStore = createAgentsStore({ journalDir, clock: () => LATER })
    const second = await laterStore.revokeAgent('research-bot')

    expect(second.revokedAt).toBe(first.revokedAt)
    expect(second.revokedAt).toBe(FIXED_NOW.toISOString())
  })

  test('unknown agent → AgentNotFoundError', async () => {
    await expect(store.revokeAgent('nobody')).rejects.toBeInstanceOf(AgentNotFoundError)
  })
})

describe('grantServer / ungrantServer', () => {
  test('grant records the tool list for the server', async () => {
    await store.createAgent('research-bot')

    const agent = await store.grantServer('research-bot', 'github', ['get_*', 'list_issues'])

    expect(agent.grants['github']).toEqual({ tools: ['get_*', 'list_issues'] })
  })

  test("grant with '*' records everything-granted", async () => {
    await store.createAgent('research-bot')

    const agent = await store.grantServer('research-bot', 'github', '*')

    expect(agent.grants['github']).toEqual({ tools: '*' })
  })

  test('a repeated grant REPLACES the previous grant wholesale (no merging)', async () => {
    await store.createAgent('research-bot')
    await store.grantServer('research-bot', 'github', ['get_*', 'list_issues'])

    const agent = await store.grantServer('research-bot', 'github', ['search_*'])

    expect(agent.grants['github']).toEqual({ tools: ['search_*'] })
  })

  test('grants to different servers coexist', async () => {
    await store.createAgent('research-bot')
    await store.grantServer('research-bot', 'github', ['get_*'])

    const agent = await store.grantServer('research-bot', 'jira', '*')

    expect(Object.keys(agent.grants).sort()).toEqual(['github', 'jira'])
  })

  test.each(['GitHub', '-bad', '', 'x'.repeat(65), 'constructor', 'prototype'])(
    'invalid or reserved server name %j → InvalidServerNameError',
    async (server) => {
      await store.createAgent('research-bot')

      await expect(store.grantServer('research-bot', server, '*')).rejects.toBeInstanceOf(
        InvalidServerNameError,
      )
    },
  )

  test.each(['a*b', '*x', '', '*', '__proto__'])(
    'invalid tool pattern %j → InvalidToolPatternError',
    async (pattern) => {
      await store.createAgent('research-bot')

      await expect(store.grantServer('research-bot', 'github', [pattern])).rejects.toBeInstanceOf(
        InvalidToolPatternError,
      )
    },
  )

  test('grant to an unknown agent → AgentNotFoundError', async () => {
    await expect(store.grantServer('nobody', 'github', '*')).rejects.toBeInstanceOf(
      AgentNotFoundError,
    )
  })

  test('ungrant removes exactly that server grant', async () => {
    await store.createAgent('research-bot')
    await store.grantServer('research-bot', 'github', '*')
    await store.grantServer('research-bot', 'jira', '*')

    const agent = await store.ungrantServer('research-bot', 'github')

    expect(Object.keys(agent.grants)).toEqual(['jira'])
  })

  test('ungrant of a server that was never granted is idempotent (no error)', async () => {
    await store.createAgent('research-bot')

    const agent = await store.ungrantServer('research-bot', 'github')

    expect(agent.grants).toEqual({})
  })

  test('ungrant on an unknown agent → AgentNotFoundError', async () => {
    await expect(store.ungrantServer('nobody', 'github')).rejects.toBeInstanceOf(
      AgentNotFoundError,
    )
  })
})

describe('getAgent / listAgents', () => {
  test('getAgent returns the stored record, unknown name → undefined', async () => {
    const { agent } = await store.createAgent('research-bot')

    expect(await store.getAgent('research-bot')).toEqual(agent)
    expect(await store.getAgent('nobody')).toBeUndefined()
  })

  test('listAgents returns all records sorted by name', async () => {
    await store.createAgent('zeta')
    await store.createAgent('alpha')

    const names = (await store.listAgents()).map((agent) => agent.name)

    expect(names).toEqual(['alpha', 'zeta'])
  })

  test('listAgents on a fresh store → empty array', async () => {
    expect(await store.listAgents()).toEqual([])
  })
})

describe('findAgentByToken', () => {
  test('returns the matching agent for a live token', async () => {
    const { token } = await store.createAgent('research-bot')
    await store.createAgent('other-bot')

    const found = await store.findAgentByToken(token)

    expect(found?.name).toBe('research-bot')
  })

  test('unknown token → undefined', async () => {
    await store.createAgent('research-bot')

    expect(await store.findAgentByToken('mcpj_definitely-not-a-real-token')).toBeUndefined()
  })

  test('revoked agent → undefined (dead token)', async () => {
    const { token } = await store.createAgent('research-bot')
    await store.revokeAgent('research-bot')

    expect(await store.findAgentByToken(token)).toBeUndefined()
  })
})

// Read file content once at the end to double-check persistence shape.
describe('persistence shape', () => {
  test('the file on disk carries version 1 and the record under its name', async () => {
    await store.createAgent('research-bot')

    const raw = JSON.parse(await readFile(join(journalDir, AGENTS_FILE_NAME), 'utf8')) as {
      version: number
      agents: Record<string, { name: string }>
    }

    expect(raw.version).toBe(1)
    expect(raw.agents['research-bot']?.name).toBe('research-bot')
  })
})
