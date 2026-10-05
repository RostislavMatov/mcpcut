import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { createRootsStore } from '../../src/files/roots-store.js'
import { dispatch } from '../../src/cli.js'
import { ACCESS_EDIT_SESSION_ID } from '../../src/journal/access-edit-record.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createJournalSink } from '../../src/journal/sink.js'

/** `mcpcut files audit` through the dispatcher, on temp dirs only (never the real ~/.mcpcut). */

let base: string
let journalDir: string
let root: string
let seq = 0

beforeEach(async () => {
  seq = 0
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-files-audit-cmd-')))
  journalDir = join(base, 'state')
  await mkdir(journalDir, { recursive: true })
  root = join(base, 'data')
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
}

const NOW = new Date('2026-10-10T12:00:00.000Z')

async function files(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const io = { stdout: { write: (chunk: string) => out.push(chunk) }, stderr: { write: (chunk: string) => err.push(chunk) } }
  const code = await dispatch(['files', ...args], io, { files: { journalDir, env, clock: () => NOW } })
  return { code, out: out.join(''), err: err.join('') }
}

function id(): string {
  seq += 1
  return `01ARZ3NDEKTSV4RRFFQ69G${String(seq).padStart(4, '0')}`
}

function call(ts: string, tool: string, payload: unknown, extra: { agent?: string; outcome?: string; rule?: string } = {}): JournalRecord {
  return {
    id: id(),
    ts,
    sessionId: 'x',
    direction: 'client→server',
    kind: 'decision',
    payload,
    decision: {
      outcome: extra.outcome ?? 'allow',
      rule: extra.rule ?? 'files: allowed',
      serverName: 'files',
      toolName: tool,
      toolClass: 'read',
      quarantineState: 'known',
      argsHash: 'h',
      ...(extra.agent !== undefined ? { agentName: extra.agent } : {}),
    },
  } as unknown as JournalRecord
}

function edit(ts: string, payload: Record<string, unknown>): JournalRecord {
  return {
    id: id(),
    ts,
    sessionId: ACCESS_EDIT_SESSION_ID,
    direction: 'client→server',
    kind: 'access-edit',
    payload: { actor: { adminName: 'ann', role: 'owner', via: 'cli' }, ...payload },
  }
}

async function write(sessionId: string, records: readonly JournalRecord[]): Promise<void> {
  const sink = createJournalSink(sessionId, { dir: journalDir })
  for (const entry of records) sink.write({ ...entry, sessionId })
  await sink.close()
}

async function declareRoot(): Promise<void> {
  const owner = await createAdminStore({ journalDir }).createAdmin('alice', 'owner')
  expect((await files(['root', 'add', root], { [ADMIN_TOKEN_ENV_VAR]: owner.token })).code).toBe(0)
}

describe('files audit', () => {
  test('prints one line per entry, newest first, with the rule only for non-allow outcomes', async () => {
    await write('sess-1', [
      call('2026-10-04T10:56:38.079Z', 'delete_file', { path: '/data/a/x' }, { agent: 'bot', outcome: 'deny', rule: 'files: no right delete on /data/a/x' }),
      call('2026-10-04T10:00:00.000Z', 'read_file', { path: '/data/a/y' }, { agent: 'bot' }),
      call('2026-10-04T09:00:00.000Z', 'move_file', { source: '/data/a/p', destination: '/data/a/q' }),
    ])
    await write(ACCESS_EDIT_SESSION_ID, [edit('2026-10-04T11:00:00.000Z', { action: 'files.trash.restore', path: '/data/a/x', trashId: 'T1' })])

    const result = await files(['audit'])

    expect(result.code).toBe(0)
    expect(result.out.trimEnd().split('\n')).toEqual([
      '2026-10-04T11:00:00.000Z  admin ann (cli)  files.trash.restore  /data/a/x',
      '2026-10-04T10:56:38.079Z  bot  deny  delete_file  /data/a/x  files: no right delete on /data/a/x',
      '2026-10-04T10:00:00.000Z  bot  allow  read_file  /data/a/y',
      '2026-10-04T09:00:00.000Z  -  allow  move_file  /data/a/p -> /data/a/q',
    ])
    expect(result.err).toContain('4 file operation(s)')
    expect(result.err).toContain('Full record: mcpcut show plane_access')
  })

  test('--agent, --since and --path narrow the answer', async () => {
    await write('sess-1', [
      call('2026-09-01T10:00:00.000Z', 'read_file', { path: '/data/a/old' }, { agent: 'bot' }),
      call('2026-10-04T10:00:00.000Z', 'read_file', { path: '/data/a/new' }, { agent: 'bot' }),
      call('2026-10-04T10:00:01.000Z', 'read_file', { path: '/data/b/new' }, { agent: 'bot' }),
      call('2026-10-04T10:00:02.000Z', 'read_file', { path: '/data/a/new' }, { agent: 'other' }),
    ])

    const result = await files(['audit', '--agent', 'bot', '--since', '7d', '--path', '/data/a'])

    expect(result.out.trimEnd().split('\n')).toEqual(['2026-10-04T10:00:00.000Z  bot  allow  read_file  /data/a/new'])
  })

  test('--path is resolved to an absolute path', async () => {
    await write('sess-1', [call('2026-10-04T10:00:00.000Z', 'read_file', { path: resolve('rel/x') }, { agent: 'bot' })])

    const result = await files(['audit', '--path', 'rel'])

    expect(result.out).toContain(resolve('rel/x'))
  })

  test('says how many are shown and how to see more when --limit cut the list', async () => {
    await write('sess-1', [
      call('2026-10-04T10:00:00.000Z', 'read_file', { path: '/data/1' }, { agent: 'bot' }),
      call('2026-10-04T10:00:01.000Z', 'read_file', { path: '/data/2' }, { agent: 'bot' }),
      call('2026-10-04T10:00:02.000Z', 'read_file', { path: '/data/3' }, { agent: 'bot' }),
    ])

    const result = await files(['audit', '--limit', '2'])

    expect(result.out.trimEnd().split('\n')).toHaveLength(2)
    expect(result.err).toContain('Showing the newest 2 — more with --limit 4')
  })

  test('says so when the journal walk stopped early', async () => {
    const records = Array.from({ length: 1002 }, (_unused, index) =>
      call(`2026-10-04T10:00:00.${String(index % 1000).padStart(3, '0')}Z`, 'read_file', { path: `/data/${index}` }, { agent: 'bot' }),
    )
    await write('sess-1', records)

    const result = await files(['audit', '--limit', '5'])

    expect(result.err).toContain('Searched only the newest sessions or file calls — narrow with --since or --agent')
  })

  test('--json prints only the object on stdout', async () => {
    await write('sess-1', [call('2026-10-04T10:00:00.000Z', 'read_file', { path: '/data/a' }, { agent: 'bot' })])

    const result = await files(['audit', '--json'])

    const parsed = JSON.parse(result.out) as { entries: Array<{ action: string; paths: string[] }>; hasMore: boolean; truncated: boolean }
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]).toMatchObject({ action: 'read_file', paths: ['/data/a'] })
    expect(parsed).toMatchObject({ hasMore: false, truncated: false })
    expect(Object.keys(parsed).sort()).toEqual(['entries', 'hasMore', 'truncated'])
  })

  test('control characters in journal values never reach the terminal raw', async () => {
    await write('sess-1', [call('2026-10-04T10:00:00.000Z', 'read_file', { path: '/data/a\u001b[31mred' }, { agent: 'b\u0007ot' })])

    const result = await files(['audit'])

    expect(result.out).not.toContain('\u001b')
    expect(result.out).not.toContain('\u0007')
  })
})

describe('files audit — empty states', () => {
  test('no roots declared → how to declare one', async () => {
    const result = await files(['audit'])

    expect(result.code).toBe(0)
    expect(result.out).toBe('')
    expect(result.err).toContain('No file operations recorded. Declare a folder first: mcpcut files root add <folder>')
  })

  test('roots but no operations → how to give an agent access', async () => {
    // Straight into the store: `root add` itself leaves an admin edit in the journal.
    await createRootsStore({ journalDir }).add(root)
    await createAgentsStore({ journalDir }).createAgent('bot')

    const result = await files(['audit'])

    expect(result.err).toContain('No file operations recorded yet.')
    expect(result.err).toContain(`mcpcut files grant bot ${root} --ops read`)
  })

  test('filters given → says to drop one or widen --since, with the command without filters', async () => {
    await declareRoot()

    const result = await files(['audit', '--agent', 'ghost'])

    expect(result.err).toContain('No file operations match these filters — drop one or widen --since.')
    expect(result.err).toContain('All file operations: mcpcut files audit\n')
  })

  test('--json on an empty journal is still one valid object', async () => {
    const result = await files(['audit', '--json'])

    expect(JSON.parse(result.out)).toEqual({ entries: [], hasMore: false, truncated: false })
  })
})

describe('files audit — bad input', () => {
  test.each(['yesterday', '0d', '3651d', '2026-02-30'])('--since %s → one line with both forms', async (since) => {
    const result = await files(['audit', '--since', since])

    expect(result.code).toBe(1)
    expect(result.err.trim().split('\n')).toHaveLength(1)
    expect(result.err).toContain('YYYY-MM-DD')
    expect(result.err).toContain('<N>d')
  })

  test.each(['0', '1001', 'abc', '1.5', '-3'])('--limit %s → one line', async (limit) => {
    const result = await files(['audit', `--limit=${limit}`])

    expect(result.code).toBe(1)
    expect(result.err.trim().split('\n')).toHaveLength(1)
    expect(result.err).toContain('--limit')
  })

  test.each([[['audit', 'extra']], [['audit', '--nope']]])('%j → usage', async (args) => {
    const result = await files(args)

    expect(result.code).toBe(1)
    expect(result.err).toContain('mcpcut files audit')
  })
})

describe('files audit — review fixes', () => {
  test('an admin edit says whom it was for: an agent or a group', async () => {
    await write(ACCESS_EDIT_SESSION_ID, [
      edit('2026-10-04T10:00:00.000Z', { action: 'files.grant', agent: 'bot', server: 'files', path: '/data/a' }),
      edit('2026-10-04T11:00:00.000Z', { action: 'files.grant', group: 'devs', server: 'files', path: '/data/b' }),
    ])

    const lines = (await files(['audit'])).out.trim().split('\n')

    expect(lines[0]).toContain('files.grant  for group devs  /data/b')
    expect(lines[1]).toContain('files.grant  for agent bot  /data/a')
  })

  test('--path through a symlink also finds what was recorded under the real path', async () => {
    const link = join(base, 'link')
    await symlink(root, link)
    await write(ACCESS_EDIT_SESSION_ID, [edit('2026-10-04T10:00:00.000Z', { action: 'files.grant', agent: 'bot', path: root })])

    const result = await files(['audit', '--path', join(link, 'x.txt')])

    expect(result.out).toContain(`files.grant  for agent bot  ${root}`)
  })

  test('an empty --path is refused instead of meaning the current folder', async () => {
    const result = await files(['audit', '--path='])

    expect(result.code).toBe(1)
    expect(result.err.trim().split('\n')).toHaveLength(1)
    expect(result.err).toContain('--path')
  })

  test('a control character in a recorded time never reaches the terminal raw', async () => {
    await write('sess-1', [call('2026-10-04T10:00:00.000Z\u001b[2J', 'read_file', { path: '/data/a' }, { agent: 'bot' })])

    const result = await files(['audit'])

    expect(result.out).not.toContain('\u001b')
  })
})
