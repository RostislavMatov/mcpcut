import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAdminStore } from '../../src/admin/store.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { createGroupsStore } from '../../src/groups/store.js'
import {
  runServerAdd,
  runServerList,
  runServerRemove,
  runServerShow,
  type ServerCliOptions,
} from '../../src/cli/server-cmd.js'
import { runServerRefresh, type ServerProbeOptions } from '../../src/cli/server-status-cmd.js'
import { GROUPS_FILE_NAME } from '../../src/groups/constants.js'
import { ACCESS_EDIT_SESSION_ID } from '../../src/journal/access-edit-record.js'
import type { DecisionInfo, JournalRecord } from '../../src/journal/record.js'
import { readSessionWithStats } from '../../src/journal/reader.js'
import { createJournalSink } from '../../src/journal/sink.js'
import { PROBE_MAX_CONCURRENT } from '../../src/probe/constants.js'
import type { ProbeResult } from '../../src/probe/engine.js'
import { PROBING_MARKER_FRESH_FOR_MS, type RunProbeFn } from '../../src/probe/orchestrator.js'
import { createServerStatusStore } from '../../src/probe/status-store.js'
import { REGISTRY_FILE_NAME } from '../../src/registry/constants.js'
import { createRegistryStore } from '../../src/registry/store.js'

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-server-cmd-'))
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

const ALIVE_RESULT: ProbeResult = {
  status: 'alive',
  initializeLatencyMs: 34,
  probedVia: 'initialize',
}

/**
 * Every test injects a probe engine stub: the real engine would spawn the
 * registered command or hit the registered URL over the network — neither
 * belongs in a unit test (and the http fixtures point at example.com).
 */
function stubProbe(result: ProbeResult = ALIVE_RESULT): RunProbeFn {
  return async () => result
}

/** A probe spy recording every engine call (server name + withTools). */
function spyProbe(result: ProbeResult = ALIVE_RESULT): {
  runProbe: RunProbeFn
  calls: Array<{ name: string; withTools: boolean }>
} {
  const calls: Array<{ name: string; withTools: boolean }> = []
  return {
    calls,
    runProbe: async (record, o) => {
      calls.push({ name: record.name, withTools: o.withTools })
      return result
    },
  }
}

const opts = (
  extra: { probes?: Partial<ServerProbeOptions>; env?: NodeJS.ProcessEnv } = {},
): ServerCliOptions => ({
  journalDir,
  env: extra.env ?? {},
  probes: { runProbe: stubProbe(), ...(extra.probes ?? {}) },
})

/** Registers a server directly through the store — no CLI, no registration probe. */
async function seedServer(name: string): Promise<void> {
  await createRegistryStore(journalDir).addServer({ name, transport: 'stdio', command: 'node' })
}

/** Writes a fresh alive entry (12ms) straight into the status store; `agoMs` shifts its clock back. */
async function seedAliveStatus(name: string, agoMs = 0): Promise<void> {
  const store = createServerStatusStore({
    journalDir,
    probingFreshForMs: PROBING_MARKER_FRESH_FOR_MS,
    now: () => Date.now() - agoMs,
  })
  await store.recordResult(
    name,
    { status: 'alive', probedVia: 'initialize', initializeLatencyMs: 12 },
    { initiator: { trigger: 'refresh' } },
  )
}

/** Reads one server's persisted status entry back for attribution assertions. */
async function storedStatusOf(name: string): Promise<unknown> {
  const store = createServerStatusStore({ journalDir, probingFreshForMs: PROBING_MARKER_FRESH_FOR_MS })
  return store.getStatus(name)
}

const ADD_GITHUB = [
  'github',
  '--transport', 'stdio',
  '--command', 'npx',
  '--args', '-y,@modelcontextprotocol/server-github',
  '--env', 'GITHUB_PERSONAL_ACCESS_TOKEN=vault:github-pat',
]

describe('server add', () => {
  test('adds a stdio server with args and env; record lands in registry.json', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(ADD_GITHUB, io, opts())

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('github')
    const store = createRegistryStore(journalDir)
    expect(await store.getServer('github')).toEqual({
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'vault:github-pat' },
    })
  })

  test('adds an http server with a vault-referenced header; protocol defaults to auto', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(
      ['remote-api', '--transport', 'http', '--url', 'https://example.com/mcp', '--header', 'Authorization=vault:api-key'],
      io,
      opts(),
    )

    expect(exitCode).toBe(0)
    const store = createRegistryStore(journalDir)
    expect(await store.getServer('remote-api')).toEqual({
      name: 'remote-api',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'vault:api-key' },
      protocol: 'auto',
    })
  })

  test('rejects a secret literal in --env with the vault hint, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(
      ['github', '--transport', 'stdio', '--command', 'npx', '--env', `GITHUB_TOKEN=ghp_${'a'.repeat(36)}`],
      io,
      opts(),
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('vault set')
  })

  test('validation errors are printed one per line as path: message', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(
      ['GitHub!', '--transport', 'stdio', '--command', 'npx'],
      io,
      opts(),
    )

    expect(exitCode).toBe(1)
    const lines = io.err().trim().split('\n')
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some((line) => /^\S+: /.test(line))).toBe(true)
  })

  test('duplicate name exits 1 with an "already exists" error', async () => {
    const io = fakeIo()
    await runServerAdd(ADD_GITHUB, fakeIo(), opts())

    const exitCode = await runServerAdd(ADD_GITHUB, io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('already exists')
  })

  test('missing --transport exits 1 with a helpful message', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(['github', '--command', 'npx'], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('--transport')
  })

  test('missing name positional prints usage, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(['--transport', 'stdio', '--command', 'npx'], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })

  test('malformed --env (no "=") exits 1 naming the bad flag value', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(
      ['github', '--transport', 'stdio', '--command', 'npx', '--env', 'NOEQUALS'],
      io,
      opts(),
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('NOEQUALS')
  })

  test('duplicate --env key exits 1', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(
      ['github', '--transport', 'stdio', '--command', 'npx', '--env', 'A=1', '--env', 'A=2'],
      io,
      opts(),
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('A')
  })

  test('--env __proto__=x is rejected', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(
      ['github', '--transport', 'stdio', '--command', 'npx', '--env', '__proto__=x'],
      io,
      opts(),
    )

    expect(exitCode).toBe(1)
  })

  test('mixing --url into a stdio record is a validation error', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(
      ['github', '--transport', 'stdio', '--command', 'npx', '--url', 'https://example.com'],
      io,
      opts(),
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('url')
  })

  test('unknown flag prints usage, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(['github', '--bogus'], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })
})

describe('server list', () => {
  test('empty registry prints a friendly message, exit 0', async () => {
    const io = fakeIo()

    const exitCode = await runServerList([], io, opts())

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('no servers')
  })

  test('lists name, transport and command/url', async () => {
    await runServerAdd(ADD_GITHUB, fakeIo(), opts())
    await runServerAdd(['remote-api', '--transport', 'http', '--url', 'https://example.com/mcp'], fakeIo(), opts())
    const io = fakeIo()

    const exitCode = await runServerList([], io, opts())

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out).toContain('github')
    expect(out).toContain('stdio')
    expect(out).toContain('npx')
    expect(out).toContain('remote-api')
    expect(out).toContain('http')
    expect(out).toContain('https://example.com/mcp')
  })

  test('a very long url is shortened in the table', async () => {
    const longPath = 'a'.repeat(200)
    await runServerAdd(['long', '--transport', 'http', '--url', `https://example.com/${longPath}`], fakeIo(), opts())
    const io = fakeIo()

    await runServerList([], io, opts())

    expect(io.out()).not.toContain(longPath)
    expect(io.out()).toContain('…')
  })

  test('unknown flag prints usage, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await runServerList(['--bogus'], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })
})

describe('server show', () => {
  test('prints the full record; vault references and env literals are shown as-is', async () => {
    await runServerAdd([...ADD_GITHUB, '--env', 'LOG_LEVEL=debug'], fakeIo(), opts())
    const io = fakeIo()

    const exitCode = await runServerShow(['github'], io, opts())

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out).toContain('name: github')
    expect(out).toContain('transport: stdio')
    expect(out).toContain('command: npx')
    expect(out).toContain('GITHUB_PERSONAL_ACCESS_TOKEN: vault:github-pat')
    expect(out).toContain('LOG_LEVEL: debug')
  })

  test('prints http fields including the defaulted protocol', async () => {
    await runServerAdd(['remote-api', '--transport', 'http', '--url', 'https://example.com/mcp'], fakeIo(), opts())
    const io = fakeIo()

    const exitCode = await runServerShow(['remote-api'], io, opts())

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('url: https://example.com/mcp')
    expect(io.out()).toContain('protocol: auto')
  })

  test('unknown server exits 1 and echoes the name safely', async () => {
    const io = fakeIo()

    const exitCode = await runServerShow(['nope'], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('nope')
  })

  test('control characters in the requested name are neutralized in the error output', async () => {
    const io = fakeIo()

    const exitCode = await runServerShow(['evil\x1b[2Jserver'], io, opts())

    expect(exitCode).toBe(1)
    const withoutLineBreaks = io.err().replace(/\n/g, '')
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x1f\x7f]/.test(withoutLineBreaks)).toBe(false)
  })

  test('missing name prints usage, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await runServerShow([], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })
})

describe('server remove', () => {
  test('removes an existing server, exit 0; it is gone afterwards', async () => {
    await runServerAdd(ADD_GITHUB, fakeIo(), opts())
    const io = fakeIo()

    const exitCode = await runServerRemove(['github'], io, opts())

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('github')
    expect(await runServerShow(['github'], fakeIo(), opts())).toBe(1)
  })

  test('removing an unknown server exits 1', async () => {
    const io = fakeIo()

    const exitCode = await runServerRemove(['nope'], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('nope')
  })

  test('missing name prints usage, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await runServerRemove([], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })

  test('corrupt registry.json surfaces a loud error instead of pretending success', async () => {
    await writeFile(join(journalDir, REGISTRY_FILE_NAME), '{ not json', 'utf8')
    const io = fakeIo()

    const exitCode = await runServerRemove(['github'], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('corrupt')
  })
})

/** Reads every access-edit record written under the reserved session. */
async function accessEditRecords(): Promise<readonly JournalRecord[]> {
  const read = await readSessionWithStats(ACCESS_EDIT_SESSION_ID, { dir: journalDir })
  expect(read.skippedLineCount).toBe(0)
  return read.records
}

/** Seeds two agents and one group all granting `server`, plus one bystander of each. */
async function seedGrantHolders(server: string): Promise<void> {
  const agents = createAgentsStore({ journalDir })
  await agents.createAgent('bot-a')
  await agents.createAgent('bot-b')
  await agents.createAgent('bystander')
  await agents.grantServer('bot-a', server, ['read_file'])
  await agents.grantServer('bot-b', server, '*')
  await agents.grantServer('bystander', 'other', ['read_file'])
  const groups = createGroupsStore({ journalDir })
  await groups.createGroup('analytics')
  await groups.createGroup('idle')
  await groups.grantServer('analytics', server, ['read_file'])
}

describe('server remove — cascade into grants and groups (G6, Task 10)', () => {
  test('drops the server from every agent grant and every group, and says how many', async () => {
    await seedServer('github')
    await seedGrantHolders('github')
    const io = fakeIo()

    const exitCode = await runServerRemove(['github'], io, opts())

    expect(exitCode).toBe(0)
    expect(io.out()).toBe('removed server "github"; cascaded: 2 agent grants, 1 groups\n')
    const agents = createAgentsStore({ journalDir })
    expect(Object.keys((await agents.getAgent('bot-a'))?.grants ?? {})).toEqual([])
    expect(Object.keys((await agents.getAgent('bot-b'))?.grants ?? {})).toEqual([])
    expect(Object.keys((await agents.getAgent('bystander'))?.grants ?? {})).toEqual(['other'])
    const groups = await createGroupsStore({ journalDir }).listGroups()
    expect(groups.map((group) => Object.keys(group.grants))).toEqual([[], []])
  })

  test('the cascade is journalled as one access-edit record naming what it touched', async () => {
    await seedServer('github')
    await seedGrantHolders('github')

    await runServerRemove(['github'], fakeIo(), opts())

    const records = await accessEditRecords()
    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe('access-edit')
    expect(records[0]?.payload).toEqual({
      actor: { adminName: null, role: null, via: 'cli' },
      action: 'server.remove',
      server: 'github',
      affectedAgents: ['bot-a', 'bot-b'],
      affectedGroups: ['analytics'],
      cascade: { agents: 'done', groups: 'done' },
    })
  })

  test('without a token the record is unattributed and stderr says so — the removal still happens', async () => {
    await seedServer('github')
    const io = fakeIo()

    const exitCode = await runServerRemove(['github'], io, opts())

    expect(exitCode).toBe(0)
    expect(io.err()).toContain('not attributed')
    expect(io.err()).toContain('MCP_ADMIN_TOKEN')
    expect(io.err()).toContain('[audit] server remove by unattributed: "github", cascaded: 0 agent grants, 0 groups')
  })

  test('a valid token attributes the record and the audit line to that admin', async () => {
    await seedServer('github')
    await seedGrantHolders('github')
    const env = await adminEnv('alice', 'owner')
    const io = fakeIo()

    const exitCode = await runServerRemove(['github'], io, opts({ env }))

    expect(exitCode).toBe(0)
    expect(io.err()).toContain('[audit] server remove by alice (owner): "github", cascaded: 2 agent grants, 1 groups')
    expect(io.err()).not.toContain('not attributed')
    const records = await accessEditRecords()
    expect(records[0]?.payload).toMatchObject({
      actor: { adminName: 'alice', role: 'owner', via: 'cli' },
    })
  })

  test('a removal that touched nothing still leaves a record, with empty cascade lists', async () => {
    await seedServer('solo')

    const exitCode = await runServerRemove(['solo'], fakeIo(), opts())

    expect(exitCode).toBe(0)
    const records = await accessEditRecords()
    expect(records).toHaveLength(1)
    expect(records[0]?.payload).toMatchObject({ affectedAgents: [], affectedGroups: [] })
  })

  test('an unknown server with nothing dangling exits 1 and journals nothing', async () => {
    await seedGrantHolders('other-server')

    const exitCode = await runServerRemove(['github'], fakeIo(), opts())

    expect(exitCode).toBe(1)
    expect(await accessEditRecords()).toHaveLength(0)
  })
})

/** Grants `server` to two agents only — no groups, so the groups half can be broken freely. */
async function seedAgentGrantHolders(server: string): Promise<void> {
  const agents = createAgentsStore({ journalDir })
  await agents.createAgent('bot-a')
  await agents.createAgent('bot-b')
  await agents.grantServer('bot-a', server, ['read_file'])
  await agents.grantServer('bot-b', server, '*')
}

/**
 * Breaks the groups document by planting an unparseable LEGACY `groups.json`
 * that the store has not imported yet: its first touch fails, which is what a
 * half-failing cascade looks like from `server remove`.
 */
async function breakGroupsStore(): Promise<void> {
  await writeFile(join(journalDir, GROUPS_FILE_NAME), '{ not json', 'utf8')
}

describe('server add — dangling grants under the same name (F8, M3a)', () => {
  test('warns when agents or groups already grant the name, exit stays 0', async () => {
    // Arrange — the state left by an earlier registration that was removed
    // without its cascade: nothing in the registry, grants still standing.
    await seedGrantHolders('github')
    const io = fakeIo()

    // Act
    const exitCode = await runServerAdd(ADD_GITHUB, io, opts())

    // Assert — re-registering the name silently hands the OLD grantees access
    // to a server that may now be something else entirely.
    expect(exitCode).toBe(0)
    expect(io.err()).toContain(
      '[warn] "github" is already granted to 2 agents and 1 groups from an earlier registration',
    )
    expect(io.err()).toContain('agent list')
    expect(io.err()).toContain('group list')
  })

  test('a name nobody grants adds without a warning', async () => {
    // Arrange
    await seedGrantHolders('other-server')
    const io = fakeIo()

    // Act
    const exitCode = await runServerAdd(ADD_GITHUB, io, opts())

    // Assert
    expect(exitCode).toBe(0)
    expect(io.err()).not.toContain('[warn]')
  })

  test('a failed add warns about nothing', async () => {
    // Arrange
    await seedGrantHolders('github')
    const io = fakeIo()

    // Act — no --transport, so the record never lands.
    const exitCode = await runServerAdd(['github'], io, opts())

    // Assert
    expect(exitCode).toBe(1)
    expect(io.err()).not.toContain('[warn]')
  })
})

describe('server remove — a half-failing cascade (F2)', () => {
  test('the agents half still runs, exit stays 0, and stderr names the failed half', async () => {
    // Arrange
    await seedServer('github')
    await seedAgentGrantHolders('github')
    await breakGroupsStore()
    const io = fakeIo()

    // Act
    const exitCode = await runServerRemove(['github'], io, opts())

    // Assert — the registry write already landed, so the command reports what
    // actually happened instead of failing after an applied change.
    expect(exitCode).toBe(0)
    expect(io.out()).toBe('removed server "github"; cascaded: 2 agent grants, 0 groups\n')
    expect(io.err()).toContain('groups')
    expect(io.err()).toContain('server remove github')
    const agents = createAgentsStore({ journalDir })
    expect(Object.keys((await agents.getAgent('bot-a'))?.grants ?? {})).toEqual([])
  })

  test('the access-edit record is still written and says which half failed', async () => {
    // Arrange
    await seedServer('github')
    await seedAgentGrantHolders('github')
    await breakGroupsStore()

    // Act
    await runServerRemove(['github'], fakeIo(), opts())

    // Assert
    const records = await accessEditRecords()
    expect(records).toHaveLength(1)
    expect(records[0]?.payload).toMatchObject({
      action: 'server.remove',
      server: 'github',
      affectedAgents: ['bot-a', 'bot-b'],
      affectedGroups: [],
      cascade: { agents: 'done', groups: 'failed' },
    })
  })

  test('the audit line is emitted even when a half failed', async () => {
    // Arrange
    await seedServer('github')
    await seedAgentGrantHolders('github')
    await breakGroupsStore()
    const io = fakeIo()

    // Act
    await runServerRemove(['github'], io, opts())

    // Assert
    expect(io.err()).toContain('[audit] server remove by unattributed: "github", cascaded: 2 agent grants, 0 groups')
  })
})

describe('server remove — repair of a dangling cascade (F2c)', () => {
  test('an unregistered server whose grants still dangle is pruned, exit 0', async () => {
    // Arrange — the state a crash between the registry write and the cascade
    // leaves behind: no registry entry, grants still pointing at the name.
    await seedGrantHolders('github')
    const io = fakeIo()

    // Act
    const exitCode = await runServerRemove(['github'], io, opts())

    // Assert
    expect(exitCode).toBe(0)
    expect(io.out()).toBe(
      'server "github" was not registered; pruned dangling grants: 2 agent grants, 1 groups\n',
    )
    const agents = createAgentsStore({ journalDir })
    expect(Object.keys((await agents.getAgent('bot-a'))?.grants ?? {})).toEqual([])
    const groups = await createGroupsStore({ journalDir }).listGroups()
    expect(groups.map((group) => Object.keys(group.grants))).toEqual([[], []])
  })

  test('the repair is journalled as a server.remove access-edit record', async () => {
    // Arrange
    await seedGrantHolders('github')

    // Act
    await runServerRemove(['github'], fakeIo(), opts())

    // Assert
    const records = await accessEditRecords()
    expect(records).toHaveLength(1)
    expect(records[0]?.payload).toMatchObject({
      action: 'server.remove',
      server: 'github',
      affectedAgents: ['bot-a', 'bot-b'],
      affectedGroups: ['analytics'],
      cascade: { agents: 'done', groups: 'done' },
    })
  })

  test('a second run finds nothing left to prune and falls back to exit 1', async () => {
    // Arrange
    await seedGrantHolders('github')
    await runServerRemove(['github'], fakeIo(), opts())
    const io = fakeIo()

    // Act
    const exitCode = await runServerRemove(['github'], io, opts())

    // Assert
    expect(exitCode).toBe(1)
    expect(io.err()).toContain('unknown server "github"')
    expect(await accessEditRecords()).toHaveLength(1)
  })
})

/** ISO timestamp of a moment `ms` before now. */
function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

/** Seeds one allowed decision for `serverName` into journal.db through the real sink. */
async function seedAllowedDecision(serverName: string, agoMs: number): Promise<void> {
  const decision: DecisionInfo = {
    outcome: 'allow',
    rule: 'classDefaults.read',
    serverName,
    toolName: 'list_issues',
    toolClass: 'read',
    quarantineState: 'known',
    argsHash: 'sha256:abc',
  }
  const record: JournalRecord = {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: isoAgo(agoMs),
    sessionId: 'session-1',
    direction: 'client→server',
    kind: 'decision',
    payload: null,
    decision,
  }
  const sink = createJournalSink('session-1', { dir: journalDir })
  sink.write(record)
  await sink.close()
}

/** Mints an admin and returns an env carrying their personal token. */
async function adminEnv(name: string, role: 'owner' | 'operator' | 'viewer'): Promise<NodeJS.ProcessEnv> {
  const { token } = await createAdminStore({ journalDir }).createAdmin(name, role)
  return { MCP_ADMIN_TOKEN: token }
}

describe('server list status column (M5.5 п.1, Task 8)', () => {
  test('stale servers are probed and the table shows ✓ with latency', async () => {
    await seedServer('github')
    const spy = spyProbe()
    const io = fakeIo()

    const exitCode = await runServerList([], io, opts({ probes: { runProbe: spy.runProbe } }))

    expect(exitCode).toBe(0)
    expect(spy.calls).toHaveLength(1)
    expect(io.out()).toContain('STATUS')
    expect(io.out()).toContain('✓ 34ms')
  })

  test('a lazy list probe does not re-shoot tools/list (withTools false)', async () => {
    await seedServer('github')
    const spy = spyProbe()

    await runServerList([], fakeIo(), opts({ probes: { runProbe: spy.runProbe } }))

    expect(spy.calls).toEqual([{ name: 'github', withTools: false }])
  })

  test('a fresh stored status is printed from the store without probing', async () => {
    await seedServer('github')
    await seedAliveStatus('github')
    const spy = spyProbe()
    const io = fakeIo()

    const exitCode = await runServerList([], io, opts({ probes: { runProbe: spy.runProbe } }))

    expect(exitCode).toBe(0)
    expect(spy.calls).toHaveLength(0)
    expect(io.out()).toContain('✓ 12ms')
    expect(io.out()).not.toContain('(stale)')
  })

  test('fresh journal traffic serves as the status without probing', async () => {
    await seedServer('github')
    await seedAllowedDecision('github', 5 * 60_000)
    const spy = spyProbe()
    const io = fakeIo()

    const exitCode = await runServerList([], io, opts({ probes: { runProbe: spy.runProbe } }))

    expect(exitCode).toBe(0)
    expect(spy.calls).toHaveLength(0)
    expect(io.out()).toContain('✓ traffic')
  })

  test('a failed probe renders ✗ with the verdict; the command still exits 0', async () => {
    await seedServer('github')
    const io = fakeIo()

    const exitCode = await runServerList(
      [],
      io,
      opts({ probes: { runProbe: stubProbe({ status: 'unreachable', message: 'no answer' }) } }),
    )

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('✗ unreachable')
  })

  test('N stale servers: at most the cap probes at once, and the command returns by the shared deadline, not N×timeout', async () => {
    for (const name of ['a1', 'a2', 'a3', 'a4', 'a5']) {
      await seedServer(name)
    }
    await seedServer('zzz')
    await seedAliveStatus('zzz', 2 * 3_600_000)
    let active = 0
    let maxActive = 0
    const runProbe: RunProbeFn = () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      return new Promise<ProbeResult>(() => {}) // never settles — a hung server
    }
    const io = fakeIo()
    const startedAt = Date.now()

    const exitCode = await runServerList(
      [],
      io,
      opts({ probes: { runProbe, listDeadlineMs: 150 } }),
    )

    expect(exitCode).toBe(0)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(maxActive).toBe(PROBE_MAX_CONCURRENT)
    expect(io.out()).toContain('probing')
    // The queued-out server keeps its old entry, marked as stale.
    expect(io.out()).toContain('✓ 12ms (stale)')
  })

  test('MCP_ADMIN_TOKEN attributes the lazy probe to the named admin', async () => {
    await seedServer('github')
    const env = await adminEnv('alice', 'viewer')

    await runServerList([], fakeIo(), opts({ env }))

    expect(await storedStatusOf('github')).toMatchObject({
      status: 'alive',
      initiator: { trigger: 'lazy', adminName: 'alice' },
    })
  })

  test('without a token the lazy probe stays unattributed and list still works', async () => {
    await seedServer('github')
    const io = fakeIo()

    const exitCode = await runServerList([], io, opts())

    expect(exitCode).toBe(0)
    expect(await storedStatusOf('github')).toMatchObject({ initiator: { trigger: 'lazy' } })
    const stored = (await storedStatusOf('github')) as { initiator: Record<string, unknown> }
    expect(stored.initiator['adminName']).toBeUndefined()
  })
})

describe('server show status (M5.5 п.1, Task 8)', () => {
  test('a stale status triggers a synchronous probe and the fresh result is printed', async () => {
    await seedServer('github')
    const spy = spyProbe()
    const io = fakeIo()

    const exitCode = await runServerShow(['github'], io, opts({ probes: { runProbe: spy.runProbe } }))

    expect(exitCode).toBe(0)
    expect(spy.calls).toHaveLength(1)
    expect(io.out()).toContain('status: alive')
    expect(io.out()).toContain('34ms')
    expect(io.out()).toContain('initialize')
  })

  test('a fresh status is printed without probing', async () => {
    await seedServer('github')
    await seedAliveStatus('github')
    const spy = spyProbe()
    const io = fakeIo()

    const exitCode = await runServerShow(['github'], io, opts({ probes: { runProbe: spy.runProbe } }))

    expect(exitCode).toBe(0)
    expect(spy.calls).toHaveLength(0)
    expect(io.out()).toContain('12ms')
  })

  test('vault-refused is printed with its reason (names, never values)', async () => {
    await seedServer('github')
    const io = fakeIo()

    const exitCode = await runServerShow(
      ['github'],
      io,
      opts({
        probes: {
          runProbe: stubProbe({
            status: 'vault-refused',
            message: 'secret "github-pat" is not in the vault',
          }),
        },
      }),
    )

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('vault-refused')
    expect(io.out()).toContain('github-pat')
  })
})

describe('server refresh (M5.5 п.1, Task 8)', () => {
  test('without MCP_ADMIN_TOKEN it refuses with a hint and probes nothing', async () => {
    await seedServer('github')
    const spy = spyProbe()
    const io = fakeIo()

    const exitCode = await runServerRefresh(['github'], io, opts({ probes: { runProbe: spy.runProbe } }))

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('MCP_ADMIN_TOKEN')
    expect(spy.calls).toHaveLength(0)
  })

  test('a viewer token is refused naming the required role', async () => {
    await seedServer('github')
    const env = await adminEnv('vera', 'viewer')
    const spy = spyProbe()
    const io = fakeIo()

    const exitCode = await runServerRefresh(
      ['github'],
      io,
      opts({ env, probes: { runProbe: spy.runProbe } }),
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('operator')
    expect(spy.calls).toHaveLength(0)
  })

  test('an operator token probes with tools/list, prints the outcome and exits 0 when alive', async () => {
    await seedServer('github')
    const env = await adminEnv('olga', 'operator')
    const spy = spyProbe()
    const io = fakeIo()

    const exitCode = await runServerRefresh(
      ['github'],
      io,
      opts({ env, probes: { runProbe: spy.runProbe } }),
    )

    expect(exitCode).toBe(0)
    expect(spy.calls).toEqual([{ name: 'github', withTools: true }])
    expect(io.out()).toContain('alive')
    expect(io.out()).toContain('34ms')
    expect(await storedStatusOf('github')).toMatchObject({
      initiator: { trigger: 'refresh', adminName: 'olga' },
    })
  })

  test('a non-alive outcome prints its reason and exits 1', async () => {
    await seedServer('github')
    const env = await adminEnv('olga', 'operator')
    const io = fakeIo()

    const exitCode = await runServerRefresh(
      ['github'],
      io,
      opts({ env, probes: { runProbe: stubProbe({ status: 'unreachable', message: 'no answer within 10000ms' }) } }),
    )

    expect(exitCode).toBe(1)
    expect(io.out()).toContain('unreachable')
    expect(io.out()).toContain('no answer within 10000ms')
  })

  test('newly quarantined tools are printed once; an unchanged schemaHash is not re-quarantined', async () => {
    await seedServer('github')
    const env = await adminEnv('olga', 'operator')
    const withTools: ProbeResult = {
      ...ALIVE_RESULT,
      tools: [{ name: 'do_thing', description: 'd', inputSchema: { type: 'object' } }],
    }
    const first = fakeIo()
    const second = fakeIo()

    await runServerRefresh(['github'], first, opts({ env, probes: { runProbe: stubProbe(withTools) } }))
    await runServerRefresh(['github'], second, opts({ env, probes: { runProbe: stubProbe(withTools) } }))

    expect(first.out()).toContain('quarantined: do_thing')
    expect(second.out()).not.toContain('do_thing')
  })

  test('an unknown server exits 1 naming it', async () => {
    const env = await adminEnv('olga', 'operator')
    const io = fakeIo()

    const exitCode = await runServerRefresh(['nope'], io, opts({ env }))

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('nope')
  })

  test('missing name prints usage, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await runServerRefresh([], io, opts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })
})

describe('server add auto-probe (M5.5 п.1, Task 8)', () => {
  test('a successful add probes the server with registration attribution and prints the result', async () => {
    const spy = spyProbe()
    const io = fakeIo()

    const exitCode = await runServerAdd(ADD_GITHUB, io, opts({ probes: { runProbe: spy.runProbe } }))

    expect(exitCode).toBe(0)
    expect(spy.calls).toEqual([{ name: 'github', withTools: true }])
    expect(io.out()).toContain('probe:')
    expect(io.out()).toContain('alive')
    expect(io.out()).toContain('34ms')
    expect(await storedStatusOf('github')).toMatchObject({ initiator: { trigger: 'registration' } })
  })

  test('MCP_ADMIN_TOKEN attributes the registration probe by name', async () => {
    const env = await adminEnv('oskar', 'owner')

    await runServerAdd(ADD_GITHUB, fakeIo(), opts({ env }))

    expect(await storedStatusOf('github')).toMatchObject({
      initiator: { trigger: 'registration', adminName: 'oskar' },
    })
  })

  test('vault-refused: the server IS registered and the probe explains why it could not try; exit stays 0', async () => {
    const io = fakeIo()

    const exitCode = await runServerAdd(
      ADD_GITHUB,
      io,
      opts({
        probes: {
          runProbe: stubProbe({
            status: 'vault-refused',
            message: 'secret "github-pat" is not in the vault',
          }),
        },
      }),
    )

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('vault-refused')
    expect(io.out()).toContain('github-pat')
    expect(await createRegistryStore(journalDir).getServer('github')).toBeDefined()
  })

  test('a failed add probes nothing', async () => {
    await runServerAdd(ADD_GITHUB, fakeIo(), opts())
    const spy = spyProbe()

    const exitCode = await runServerAdd(ADD_GITHUB, fakeIo(), opts({ probes: { runProbe: spy.runProbe } }))

    expect(exitCode).toBe(1)
    expect(spy.calls).toHaveLength(0)
  })
})
