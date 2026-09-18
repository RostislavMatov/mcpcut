import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAdminStore } from '../../src/admin/store.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { runServerAdd, runServerList, runServerRemove, runServerShow, type ServerCliOptions } from '../../src/cli/server-cmd.js'
import { ACCESS_EDIT_SESSION_ID } from '../../src/journal/access-edit-record.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { readSessionWithStats } from '../../src/journal/reader.js'
import type { ProbeResult } from '../../src/probe/engine.js'
import type { RunProbeFn } from '../../src/probe/orchestrator.js'
import { createRegistryStore } from '../../src/registry/store.js'

/**
 * The owner gate in front of `server add` and `server remove` (owner decision
 * 2026-09-18, user-journey smoke UX-9).
 *
 * Registering a server decides which process the plane may launch, and the
 * registration probe RUNS it once; removing one rewrites every grant that
 * named it. The admin UI has always kept both behind `owner`, while the shell
 * let anybody through and wrote "nobody named". These tests pin the parity:
 * no owner token — nothing is written, nothing is run, nothing is journalled.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-server-gate-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function fakeIo(): {
  stdout: { write: (chunk: string) => void }
  stderr: { write: (chunk: string) => void }
  out: () => string
  err: () => string
} {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

const ALIVE_RESULT: ProbeResult = { status: 'alive', initializeLatencyMs: 34, probedVia: 'initialize' }

/** A probe spy: the gate must refuse BEFORE the registered command could run. */
function spyProbe(): { runProbe: RunProbeFn; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    runProbe: async (record) => {
      calls.push(record.name)
      return ALIVE_RESULT
    },
  }
}

const optsWith = (env: NodeJS.ProcessEnv, runProbe: RunProbeFn = spyProbe().runProbe): ServerCliOptions => ({
  journalDir,
  env,
  probes: { runProbe },
})

async function adminEnv(name: string, role: 'owner' | 'operator' | 'viewer'): Promise<NodeJS.ProcessEnv> {
  const { token } = await createAdminStore({ journalDir }).createAdmin(name, role)
  return { MCP_ADMIN_TOKEN: token }
}

async function seedServer(name: string): Promise<void> {
  await createRegistryStore(journalDir).addServer({ name, transport: 'stdio', command: 'node' })
}

async function accessEditRecords(): Promise<readonly JournalRecord[]> {
  const read = await readSessionWithStats(ACCESS_EDIT_SESSION_ID, { dir: journalDir })
  expect(read.skippedLineCount).toBe(0)
  return read.records
}

const ADD_NOTES = ['notes', '--transport', 'stdio', '--command', 'node']

describe('server add — owner gate', () => {
  test('without a token it refuses, registers nothing, runs nothing and journals nothing', async () => {
    const spy = spyProbe()
    const io = fakeIo()

    const exitCode = await runServerAdd(ADD_NOTES, io, optsWith({}, spy.runProbe))

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Refusing to change the server registry: no admin token')
    expect(io.err()).toContain('MCP_ADMIN_TOKEN')
    expect(io.err()).toContain('admin add <name> --role owner')
    expect(io.out()).toBe('')
    expect(await createRegistryStore(journalDir).getServer('notes')).toBeUndefined()
    expect(spy.calls).toEqual([])
    await expect(accessEditRecords()).resolves.toEqual([])
  })

  test('an operator token is refused naming the required role and the way to get it', async () => {
    const env = await adminEnv('olga', 'operator')
    const spy = spyProbe()
    const io = fakeIo()

    const exitCode = await runServerAdd(ADD_NOTES, io, optsWith(env, spy.runProbe))

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Refusing to change the server registry')
    expect(io.err()).toContain('role "owner" is required')
    expect(io.err()).toContain('admin role olga owner')
    expect(await createRegistryStore(journalDir).getServer('notes')).toBeUndefined()
    expect(spy.calls).toEqual([])
    await expect(accessEditRecords()).resolves.toEqual([])
  })

  test('a token that matches no admin is refused rather than run anonymously', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(ADD_NOTES, io, optsWith({ MCP_ADMIN_TOKEN: 'mcpa_not-a-real-token' }))

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('does not match any active admin')
    expect(await createRegistryStore(journalDir).getServer('notes')).toBeUndefined()
  })

  test('an owner token registers, probes and records the owner by name', async () => {
    const env = await adminEnv('alice', 'owner')
    const spy = spyProbe()
    const io = fakeIo()

    const exitCode = await runServerAdd(ADD_NOTES, io, optsWith(env, spy.runProbe))

    expect(exitCode).toBe(0)
    expect(io.err()).toContain('[audit] server add by alice (owner): "notes"')
    expect(io.err()).not.toContain('not attributed')
    expect(spy.calls).toEqual(['notes'])
    const records = await accessEditRecords()
    expect(records.map((record) => record.payload)).toEqual([
      { actor: { adminName: 'alice', role: 'owner', via: 'cli' }, action: 'server.add', server: 'notes' },
    ])
  })

  test('a usage error is still a usage error: the gate does not hide it behind a token request', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd([], io, optsWith({}))

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage:')
    expect(io.err()).not.toContain('Refusing')
  })
})

describe('server remove — owner gate', () => {
  test('without a token it refuses and the server, its grants and the journal stay as they were', async () => {
    await seedServer('notes')
    const agents = createAgentsStore({ journalDir })
    await agents.createAgent('bot')
    await agents.grantServer('bot', 'notes', '*')
    const io = fakeIo()

    const exitCode = await runServerRemove(['notes'], io, optsWith({}))

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Refusing to change the server registry: no admin token')
    expect(io.out()).toBe('')
    expect(await createRegistryStore(journalDir).getServer('notes')).toBeDefined()
    const bot = (await agents.listAgents()).find((agent) => agent.name === 'bot')
    expect(Object.keys(bot?.grants ?? {})).toEqual(['notes'])
    await expect(accessEditRecords()).resolves.toEqual([])
  })

  test('an operator token is refused', async () => {
    await seedServer('notes')
    const env = await adminEnv('olga', 'operator')
    const io = fakeIo()

    const exitCode = await runServerRemove(['notes'], io, optsWith(env))

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('role "owner" is required')
    expect(await createRegistryStore(journalDir).getServer('notes')).toBeDefined()
  })

  test('--prune-grants is a write too: without a token nothing is pruned', async () => {
    const agents = createAgentsStore({ journalDir })
    await agents.createAgent('bot')
    await agents.grantServer('bot', 'ghost', '*')
    const io = fakeIo()

    const exitCode = await runServerRemove(['ghost', '--prune-grants'], io, optsWith({}))

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Refusing to change the server registry')
    const bot = (await agents.listAgents()).find((agent) => agent.name === 'bot')
    expect(Object.keys(bot?.grants ?? {})).toEqual(['ghost'])
    await expect(accessEditRecords()).resolves.toEqual([])
  })

  test('an owner token removes and the record names the owner — never "nobody"', async () => {
    await seedServer('notes')
    const env = await adminEnv('alice', 'owner')
    const io = fakeIo()

    const exitCode = await runServerRemove(['notes'], io, optsWith(env))

    expect(exitCode).toBe(0)
    expect(io.err()).toContain('[audit] server remove by alice (owner): "notes"')
    const records = await accessEditRecords()
    expect(records[0]?.payload).toMatchObject({
      actor: { adminName: 'alice', role: 'owner', via: 'cli' },
      action: 'server.remove',
    })
  })
})

describe('server list|show — reads stay open', () => {
  test('neither asks for a token', async () => {
    await seedServer('notes')
    const listIo = fakeIo()
    const showIo = fakeIo()

    const listExit = await runServerList([], listIo, optsWith({}))
    const showExit = await runServerShow(['notes'], showIo, optsWith({}))

    expect(listExit).toBe(0)
    expect(showExit).toBe(0)
    expect(listIo.err() + showIo.err()).not.toContain('Refusing')
  })
})
