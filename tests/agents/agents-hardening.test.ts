import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { collectPersistedBytes, type PersistedBytes } from '../support/persisted-bytes.js'
import { AGENTS_FILE_NAME } from '../../src/agents/constants.js'
import { createAgentsStore, type AgentsStore } from '../../src/agents/store.js'
import { StoreCorruptError } from '../../src/policy/store.js'

/**
 * Hardening suite for the agents store: token irrecoverability, revoked ≡
 * nonexistent, corrupt-file behavior, and prototype-pollution resistance.
 * Mirrors the `*-hardening.test.ts` convention from M2.
 */

let journalDir: string
let store: AgentsStore

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-agents-hardening-'))
  store = createAgentsStore({ journalDir })
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function agentsFilePath(): string {
  return join(journalDir, AGENTS_FILE_NAME)
}

/**
 * Every byte the plane wrote into the journal directory, as one blob rendered
 * both ways. Since M4.5 the agents document lives in `state.db` -- and, until
 * a checkpoint, its newest pages live only in the `state.db-wal` sidecar -- so
 * a scan aimed at one JSON path would prove nothing at all. Sweeping the whole
 * directory keeps this guarantee honest the next time storage moves, and the
 * two renderings mean a token cannot hide behind a byte sequence that happens
 * to be invalid UTF-8 inside a binary page.
 */
async function persistedBytes(): Promise<PersistedBytes> {
  return collectPersistedBytes(journalDir)
}

describe('token irrecoverability', () => {
  test('the serialized store NEVER contains a plaintext token (only the hash)', async () => {
    // Arrange: several agents, so any accidental plaintext write would show up
    const created = [
      await store.createAgent('bot-one'),
      await store.createAgent('bot-two'),
      await store.createAgent('bot-three'),
    ]

    // Act
    const { fileNames, renderings } = await persistedBytes()

    // Assert: the sweep actually reached the state database...
    expect(fileNames).toContain('state.db')
    // ...and really saw the agent records in it, so this can never pass by
    // scanning bytes that simply do not hold the store yet.
    for (const { agent } of created) {
      expect(renderings.some((rendering) => rendering.includes(agent.tokenHash))).toBe(true)
    }

    // The point: no full token, and no token BODY either (the random part
    // alone must not be recoverable even without its mcpj_ prefix), in any
    // file or any rendering of it.
    for (const { token } of created) {
      for (const rendering of renderings) {
        expect(rendering).not.toContain(token)
        expect(rendering).not.toContain(token.slice('mcpj_'.length))
      }
    }
  })

  test('the record returned by the API carries only the hash, never the token', async () => {
    const { agent, token } = await store.createAgent('research-bot')

    expect(JSON.stringify(agent)).not.toContain(token)
  })
})

describe('revoked ≡ nonexistent for token auth', () => {
  test('findAgentByToken returns the SAME value (undefined) for a revoked and a never-existing token', async () => {
    const { token } = await store.createAgent('research-bot')
    await store.revokeAgent('research-bot')

    const forRevoked = await store.findAgentByToken(token)
    const forNonexistent = await store.findAgentByToken('mcpj_never-was-a-token')

    expect(forRevoked).toBeUndefined()
    expect(forNonexistent).toBeUndefined()
    expect(forRevoked).toStrictEqual(forNonexistent)
  })

  test('findAgentByToken never throws on garbage candidate tokens', async () => {
    await store.createAgent('research-bot')

    for (const garbage of ['', ' ', '\0', 'mcpj_', 'Bearer xyz', 'a'.repeat(10_000)]) {
      await expect(store.findAgentByToken(garbage)).resolves.toBeUndefined()
    }
  })
})

describe('corrupt agents.json fails loudly, never as an empty store', () => {
  test('unparseable JSON → StoreCorruptError on read, not an empty agent list', async () => {
    await writeFile(agentsFilePath(), '{ not json', 'utf8')

    await expect(store.listAgents()).rejects.toBeInstanceOf(StoreCorruptError)
  })

  test('valid JSON that fails the schema → StoreCorruptError', async () => {
    await writeFile(agentsFilePath(), JSON.stringify({ version: 999 }), 'utf8')

    await expect(store.listAgents()).rejects.toBeInstanceOf(StoreCorruptError)
  })

  test('a corrupt file also fails updates (no silent overwrite with a fresh default)', async () => {
    await writeFile(agentsFilePath(), '{ not json', 'utf8')

    await expect(store.createAgent('research-bot')).rejects.toBeInstanceOf(StoreCorruptError)
    expect(await readFile(agentsFilePath(), 'utf8')).toBe('{ not json')
  })

  test('findAgentByToken on a corrupt store rejects (fail closed) instead of resolving undefined', async () => {
    await writeFile(agentsFilePath(), '{ not json', 'utf8')

    await expect(store.findAgentByToken('mcpj_whatever')).rejects.toBeInstanceOf(StoreCorruptError)
  })
})

describe('prototype-pollution resistance', () => {
  test('an on-disk file smuggling __proto__ into grants is rejected as corrupt', async () => {
    const smuggled =
      '{"version":1,"agents":{"research-bot":{"name":"research-bot",' +
      '"tokenHash":"' +
      'a'.repeat(64) +
      '","createdAt":"2026-08-05T10:00:00.000Z",' +
      '"grants":{"__proto__":{"tools":"*"}}}}}'
    await writeFile(agentsFilePath(), smuggled, 'utf8')

    await expect(store.listAgents()).rejects.toBeInstanceOf(StoreCorruptError)
    expect(({} as { tools?: unknown }).tools).toBeUndefined()
  })

  test('an on-disk file with a __proto__ agents key is rejected as corrupt', async () => {
    const smuggled =
      '{"version":1,"agents":{"__proto__":{"name":"x","tokenHash":"' +
      'a'.repeat(64) +
      '","createdAt":"2026-08-05T10:00:00.000Z","grants":{}}}}'
    await writeFile(agentsFilePath(), smuggled, 'utf8')

    await expect(store.listAgents()).rejects.toBeInstanceOf(StoreCorruptError)
  })
})
