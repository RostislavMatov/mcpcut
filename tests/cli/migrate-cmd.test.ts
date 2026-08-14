import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runMigrateCommand } from '../../src/cli/migrate-cmd.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { createRegistryStore } from '../../src/registry/store.js'
import { createApprovalQueue } from '../../src/policy/approvals/queue.js'
import { StoreCorruptError } from '../../src/policy/store.js'

/**
 * Behavior of `mcp-journal migrate`: imports legacy `*.json` state into
 * `state.db`, one line per store, then a summary line. Routing (`dispatch`
 * wiring `migrate` to this module) is covered separately in
 * `tests/cli/dispatch.test.ts`.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-migrate-cmd-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

/** Captures stdout/stderr writes for assertions instead of touching the real streams. */
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

function run(args: string[], io = fakeIo()): Promise<number> {
  return runMigrateCommand(args, io, { journalDir })
}

const AGENT_RECORD = {
  name: 'research-bot',
  tokenHash: '0'.repeat(64),
  createdAt: '2026-08-13T00:00:00.000Z',
  grants: {},
}

async function writeValidAgentsFile(): Promise<void> {
  await writeFile(
    join(journalDir, 'agents.json'),
    JSON.stringify({ version: 1, agents: { 'research-bot': AGENT_RECORD } }),
    'utf8',
  )
}

async function writeValidRegistryFile(): Promise<void> {
  await writeFile(
    join(journalDir, 'registry.json'),
    JSON.stringify({
      version: 1,
      servers: { github: { name: 'github', transport: 'stdio', command: '/bin/true' } },
    }),
    'utf8',
  )
}

describe('migrate: a directory with legacy files', () => {
  test('imports agents.json and registry.json; both readable through their stores afterward', async () => {
    await writeValidAgentsFile()
    await writeValidRegistryFile()
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(0)
    const importedLines = io.out().split('\n').filter((line) => line.includes('imported'))
    expect(importedLines).toHaveLength(2)
    expect(io.out()).toContain('agents.json')
    expect(io.out()).toContain('registry.json')
    expect(io.out()).toContain('no file')
    expect(io.out()).toContain('Migrated 2 store(s) into state.db.')

    const agents = await createAgentsStore({ journalDir }).listAgents()
    expect(agents.map((agent) => agent.name)).toEqual(['research-bot'])

    const servers = await createRegistryStore(journalDir).listServers()
    expect(servers.map((server) => server.name)).toEqual(['github'])
  })
})

describe('migrate: run twice', () => {
  test('the second run reports "already migrated" and changes nothing', async () => {
    await writeValidAgentsFile()
    await writeValidRegistryFile()
    await run([])

    const io = fakeIo()
    const exitCode = await run([], io)

    expect(exitCode).toBe(0)
    const alreadyLines = io.out().split('\n').filter((line) => line.includes('already migrated'))
    expect(alreadyLines).toHaveLength(2)
    expect(io.out()).toContain('Migrated 0 store(s) into state.db.')

    const agents = await createAgentsStore({ journalDir }).listAgents()
    expect(agents.map((agent) => agent.name)).toEqual(['research-bot'])
  })
})

describe('migrate: an empty directory', () => {
  test('reports "no file" for all four stores plus approvals, exit 0', async () => {
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(0)
    const noFileLines = io.out().split('\n').filter((line) => line.includes('no file'))
    expect(noFileLines).toHaveLength(5)
    expect(io.out()).toContain('approvals/ -> no file')
    expect(io.out()).toContain('Migrated 0 store(s) into state.db.')
  })
})

describe('migrate: a corrupt legacy file', () => {
  test('stops at the first corrupt store: stderr message, exit 1, nothing imported for it', async () => {
    await writeValidAgentsFile()
    await writeFile(join(journalDir, 'registry.json'), '{ not json at all', 'utf8')
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(1)
    expect(io.err().length).toBeGreaterThan(0)
    expect(io.err()).toContain('registry.json')
    // agents.json was processed (and reported) before the corrupt store halted the run,
    // but the run must not claim completion once it has failed partway through.
    expect(io.out()).toContain('imported')
    expect(io.out()).not.toContain('Migrated')
    // The corrupt store halts the run before the approvals step is ever reached.
    expect(io.out()).not.toContain('approvals/')

    await expect(createRegistryStore(journalDir).listServers()).rejects.toBeInstanceOf(
      StoreCorruptError,
    )
  })
})

describe('migrate: approvals queue', () => {
  const PENDING_ID = '01AAAAAAAAAAAAAAAAAAAAAAAA'
  const RESOLVED_ID = '01BBBBBBBBBBBBBBBBBBBBBBBB'

  function legacyPendingDoc(approvalId: string): string {
    return JSON.stringify({
      approvalId,
      serverName: 'github',
      toolName: 'create_issue',
      toolClass: 'write',
      argsRedacted: { title: 'hello' },
      argsHash: 'hash-1',
      sessionId: 'session-1',
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
  }

  function legacyResolvedDoc(approvalId: string): string {
    return JSON.stringify({
      approvalId,
      serverName: 'github',
      toolName: 'create_issue',
      toolClass: 'write',
      argsRedacted: { title: 'hello' },
      argsHash: 'hash-1',
      sessionId: 'session-1',
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      resolution: { outcome: 'approved', actor: 'alice' },
      resolvedAt: new Date().toISOString(),
    })
  }

  async function writeLegacyApprovals(): Promise<void> {
    const approvalsDir = join(journalDir, 'approvals')
    await mkdir(join(approvalsDir, 'pending'), { recursive: true })
    await mkdir(join(approvalsDir, 'resolved'), { recursive: true })
    await writeFile(
      join(approvalsDir, 'pending', `${PENDING_ID}.json`),
      legacyPendingDoc(PENDING_ID),
      'utf8',
    )
    await writeFile(
      join(approvalsDir, 'resolved', `${RESOLVED_ID}.json`),
      legacyResolvedDoc(RESOLVED_ID),
      'utf8',
    )
  }

  test('imports legacy pending/resolved files and reports counts; the queue is readable afterward', async () => {
    await writeLegacyApprovals()
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('state: approvals/ -> imported (1 pending, 1 resolved)')
    // Only the approvals queue had legacy data in this test; the four document
    // stores all report "no file" and do not add to the imported count.
    expect(io.out()).toContain('Migrated 1 store(s) into state.db.')

    const queue = createApprovalQueue({ baseDir: join(journalDir, 'approvals') })
    await expect(queue.list()).resolves.toHaveLength(1)
    await expect(queue.readResolution(RESOLVED_ID)).resolves.not.toBeNull()
  })

  test('a second run reports "already migrated" for approvals and imports nothing again', async () => {
    await writeLegacyApprovals()
    await run([])

    const io = fakeIo()
    const exitCode = await run([], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('state: approvals/ -> already migrated')
    expect(io.out()).toContain('Migrated 0 store(s) into state.db.')
  })

  test('no approvals directories on disk: reports "no file"', async () => {
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('state: approvals/ -> no file')
  })
})

describe('migrate: a store born in state.db', () => {
  test('is reported as native, not as already migrated', async () => {
    // No legacy file was ever imported: the row is created directly in
    // state.db. An operator auditing which hosts still hold importable
    // legacy *.json must not be told a migration happened here.
    await createAgentsStore({ journalDir }).createAgent('research-bot')
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('agents.json -> created in state.db (no legacy import)')
    expect(io.out()).not.toContain('agents.json -> already migrated')
  })
})

describe('migrate: arguments are rejected', () => {
  test('any argument aborts with exit 1 before touching any store', async () => {
    await writeValidAgentsFile()
    const io = fakeIo()

    const exitCode = await run(['--help'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('takes no arguments')
    expect(io.out()).toBe('')
  })
})

describe('migrate: a wrong-shape legacy file (valid JSON)', () => {
  test('is refused by the domain validator, imports nothing, and stays fixable on disk', async () => {
    await writeFile(
      join(journalDir, 'agents.json'),
      JSON.stringify({ version: 99, agents: 'not a map' }),
      'utf8',
    )
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('agents.json')
    expect(io.out()).not.toContain('Migrated')

    // The row was never written, so repairing the file on disk and re-running
    // the same command imports the fixed value — the failure is recoverable
    // without database surgery.
    await writeValidAgentsFile()
    const retryIo = fakeIo()
    expect(await run([], retryIo)).toBe(0)
    expect(retryIo.out()).toContain('agents.json -> imported')

    const agents = await createAgentsStore({ journalDir }).listAgents()
    expect(agents.map((agent) => agent.name)).toEqual(['research-bot'])
  })
})
