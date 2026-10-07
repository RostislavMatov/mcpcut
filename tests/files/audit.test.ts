import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { parseSince, queryFileAudit, type FileAuditEntry } from '../../src/files/audit.js'
import { ACCESS_EDIT_SESSION_ID } from '../../src/journal/access-edit-record.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createJournalSink } from '../../src/journal/sink.js'

/** `queryFileAudit` over a real journal.db in a temp dir. */

let dir: string
let seq = 0
const data = resolve('/data')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-files-audit-'))
  seq = 0
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function nextId(): string {
  seq += 1
  return `01ARZ3NDEKTSV4RRFFQ69G${String(seq).padStart(4, '0')}`
}

interface CallInput {
  readonly ts?: string
  readonly agent?: string
  readonly tool?: string
  readonly outcome?: string
  readonly rule?: string
  readonly server?: string
  readonly payload?: unknown
}

function call(input: CallInput): JournalRecord {
  return {
    id: nextId(),
    ts: input.ts ?? '2026-10-04T10:00:00.000Z',
    sessionId: 'x',
    direction: 'client→server',
    kind: 'decision',
    payload: input.payload ?? {},
    decision: {
      outcome: input.outcome ?? 'allow',
      rule: input.rule ?? 'files: allowed',
      serverName: input.server ?? 'files',
      toolName: input.tool ?? 'read_file',
      toolClass: 'read',
      quarantineState: 'known',
      argsHash: 'h',
      ...(input.agent !== undefined ? { agentName: input.agent } : {}),
    },
  } as unknown as JournalRecord
}

function edit(ts: string, payload: Record<string, unknown>): JournalRecord {
  return {
    id: nextId(),
    ts,
    sessionId: ACCESS_EDIT_SESSION_ID,
    direction: 'client→server',
    kind: 'access-edit',
    payload: { actor: { adminName: 'ann', role: 'owner', via: 'cli' }, ...payload },
  }
}

async function write(sessionId: string, records: readonly JournalRecord[]): Promise<void> {
  const sink = createJournalSink(sessionId, { dir })
  for (const entry of records) sink.write({ ...entry, sessionId })
  await sink.close()
}

async function audit(query: { path?: string; agent?: string; since?: string; limit?: number } = {}) {
  return queryFileAudit({ limit: 100, ...query }, { dir, platform: 'linux' })
}

const pathsOf = (entries: readonly FileAuditEntry[]): string[][] => entries.map((entry) => [...entry.paths])

describe('parseSince', () => {
  const now = new Date('2026-10-04T23:30:00.000Z')

  test.each([
    ['2026-09-01', '2026-09-01'],
    ['7d', '2026-09-27'],
    ['1d', '2026-10-03'],
    ['3650d', '2016-10-06'],
  ])('%s → %s', (raw, expected) => {
    expect(parseSince(raw, now)).toBe(expected)
  })

  test.each(['', 'yesterday', '0d', '3651d', '-1d', '1.5d', '2026-13-01', '2026-02-30', '2026-1-1', ' 7d'])('%j → null', (raw) => {
    expect(parseSince(raw, now)).toBeNull()
  })
})

describe('queryFileAudit — agent calls', () => {
  test('returns the files-server decisions newest first and ignores other servers', async () => {
    await write('s1', [
      call({ ts: '2026-10-04T10:00:00.000Z', agent: 'bot', tool: 'read_file', payload: { path: `${data}/a` } }),
      call({ ts: '2026-10-04T11:00:00.000Z', agent: 'bot', tool: 'write_file', payload: { path: `${data}/b`, content: 'x' } }),
      call({ ts: '2026-10-04T12:00:00.000Z', agent: 'bot', server: 'notes', tool: 'read_note', payload: { path: `${data}/c` } }),
    ])

    const result = await audit()

    expect(result.entries.map((entry) => entry.action)).toEqual(['write_file', 'read_file'])
    expect(result.entries[0]).toMatchObject({
      actor: { kind: 'agent', name: 'bot' },
      outcome: 'allow',
      rule: 'files: allowed',
      sessionId: 's1',
      paths: [`${data}/b`],
    })
    expect(result.hasMore).toBe(false)
    expect(result.truncated).toBe(false)
  })

  test('decisions that are not file tool calls (tools/list) are no file operations', async () => {
    await write('s1', [
      call({ agent: 'bot', tool: 'tools/list', rule: 'tools/list: ok' }),
      call({ agent: 'bot', tool: '', rule: 'tools/list: ok' }),
      call({ agent: 'bot', tool: 'read_file', payload: { path: `${data}/a` } }),
    ])

    const result = await audit()

    expect(result.entries.map((entry) => entry.action)).toEqual(['read_file'])
  })

  test('the agent filter keeps one agent; a call without an agent has a null name', async () => {
    await write('s1', [
      call({ agent: 'bot', payload: { path: `${data}/a` } }),
      call({ agent: 'other', payload: { path: `${data}/a` } }),
    ])
    await write('s2', [call({ payload: { path: `${data}/a` } })])

    const all = await audit()
    const filtered = await audit({ agent: 'bot' })

    expect(all.entries.map((entry) => entry.actor)).toContainEqual({ kind: 'agent', name: null })
    expect(filtered.entries.map((entry) => entry.actor)).toEqual([{ kind: 'agent', name: 'bot' }])
  })

  test('the since filter drops earlier days, for calls and admin edits alike', async () => {
    await write('s1', [
      call({ ts: '2026-09-30T23:59:59.000Z', payload: { path: `${data}/old` } }),
      call({ ts: '2026-10-01T00:00:00.000Z', payload: { path: `${data}/new` } }),
    ])
    await write(ACCESS_EDIT_SESSION_ID, [
      edit('2026-09-29T10:00:00.000Z', { action: 'files.root.add', path: data }),
      edit('2026-10-02T10:00:00.000Z', { action: 'files.root.remove', path: data }),
    ])

    const result = await audit({ since: '2026-10-01' })

    expect(result.entries.map((entry) => entry.action)).toEqual(['files.root.remove', 'read_file'])
  })

  test('a move lists source and destination', async () => {
    await write('s1', [call({ tool: 'move_file', payload: { source: `${data}/a`, destination: `${data}/b` } })])

    expect(pathsOf((await audit()).entries)).toEqual([[`${data}/a`, `${data}/b`]])
  })

  test('a deny carries its rule', async () => {
    await write('s1', [call({ tool: 'delete_file', outcome: 'deny', rule: 'files: no right delete', payload: { path: `${data}/a` } })])

    expect((await audit()).entries[0]).toMatchObject({ outcome: 'deny', rule: 'files: no right delete' })
  })
})

describe('queryFileAudit — path matching', () => {
  test('matches the path itself and anything inside it, not siblings or a longer prefix', async () => {
    await write('s1', [
      call({ ts: '2026-10-04T10:00:01.000Z', payload: { path: `${data}/a` } }),
      call({ ts: '2026-10-04T10:00:02.000Z', payload: { path: `${data}/a/deep/x` } }),
      call({ ts: '2026-10-04T10:00:03.000Z', payload: { path: `${data}/ab` } }),
      call({ ts: '2026-10-04T10:00:04.000Z', payload: { path: `${data}/b` } }),
    ])

    const result = await audit({ path: `${data}/a` })

    expect(pathsOf(result.entries)).toEqual([[`${data}/a/deep/x`], [`${data}/a`]])
  })

  test('an ancestor matches only for whole-tree actions', async () => {
    await write('s1', [
      call({ ts: '2026-10-04T10:00:01.000Z', tool: 'read_file', payload: { path: `${data}/a` } }),
      call({ ts: '2026-10-04T10:00:02.000Z', tool: 'delete_file', payload: { path: `${data}/a` } }),
      call({ ts: '2026-10-04T10:00:03.000Z', tool: 'move_file', payload: { source: `${data}/a`, destination: `${data}/z` } }),
    ])
    await write(ACCESS_EDIT_SESSION_ID, [
      edit('2026-10-04T10:00:04.000Z', { action: 'files.grant', agent: 'bot', path: `${data}/a` }),
      edit('2026-10-04T10:00:05.000Z', { action: 'files.revoke', agent: 'bot', path: `${data}/a` }),
      edit('2026-10-04T10:00:06.000Z', { action: 'files.root.add', path: data }),
      edit('2026-10-04T10:00:07.000Z', { action: 'files.root.remove', path: data }),
      edit('2026-10-04T10:00:08.000Z', { action: 'files.trash.restore', path: `${data}/a`, trashId: 'T1' }),
      edit('2026-10-04T10:00:09.000Z', { action: 'files.trash.purge', path: `${data}/a` }),
    ])

    const result = await audit({ path: `${data}/a/file.txt` })

    expect(result.entries.map((entry) => entry.action).sort()).toEqual(
      ['delete_file', 'files.grant', 'files.revoke', 'files.root.add', 'files.root.remove', 'files.trash.restore', 'move_file'].sort(),
    )
  })

  test('a move matches by its source or its destination', async () => {
    await write('s1', [
      call({ ts: '2026-10-04T10:00:01.000Z', tool: 'move_file', payload: { source: `${data}/a/x`, destination: `${data}/z/x` } }),
      call({ ts: '2026-10-04T10:00:02.000Z', tool: 'move_file', payload: { source: `${data}/q`, destination: `${data}/a/y` } }),
      call({ ts: '2026-10-04T10:00:03.000Z', tool: 'move_file', payload: { source: `${data}/q`, destination: `${data}/z` } }),
    ])

    const result = await audit({ path: `${data}/a` })

    expect(result.entries).toHaveLength(2)
  })

  test('non-absolute, redacted or non-string values never match', async () => {
    await write('s1', [
      call({ ts: '2026-10-04T10:00:01.000Z', tool: 'delete_file', payload: { path: 'a' } }),
      call({ ts: '2026-10-04T10:00:02.000Z', tool: 'delete_file', payload: { path: '[REDACTED]' } }),
      call({ ts: '2026-10-04T10:00:03.000Z', tool: 'delete_file', payload: { path: 42 } }),
      call({ ts: '2026-10-04T10:00:04.000Z', tool: 'delete_file', payload: null }),
    ])

    expect((await audit({ path: `${data}/a` })).entries).toEqual([])
    expect((await audit()).entries).toHaveLength(4)
  })
})

describe('queryFileAudit — admin edits', () => {
  test('lists files.* edits with the admin as actor and skips other actions', async () => {
    await write(ACCESS_EDIT_SESSION_ID, [
      edit('2026-10-04T11:00:00.000Z', { action: 'files.trash.restore', path: `${data}/a`, trashId: 'T1' }),
      edit('2026-10-04T11:00:01.000Z', { action: 'group.create', group: 'team' }),
    ])

    const result = await audit()

    expect(result.entries).toEqual([
      {
        ts: '2026-10-04T11:00:00.000Z',
        sessionId: ACCESS_EDIT_SESSION_ID,
        recordId: expect.any(String),
        actor: { kind: 'admin', name: 'ann', via: 'cli' },
        action: 'files.trash.restore',
        outcome: null,
        rule: null,
        subject: null,
        paths: [`${data}/a`],
      },
    ])
  })

  test('the agent filter keeps only edits about that agent; group edits drop out', async () => {
    await write(ACCESS_EDIT_SESSION_ID, [
      edit('2026-10-04T11:00:00.000Z', { action: 'files.grant', agent: 'bot', path: `${data}/a` }),
      edit('2026-10-04T11:00:01.000Z', { action: 'files.grant', agent: 'other', path: `${data}/a` }),
      edit('2026-10-04T11:00:02.000Z', { action: 'files.grant', group: 'team', path: `${data}/a` }),
      edit('2026-10-04T11:00:03.000Z', { action: 'files.root.add', path: data }),
    ])

    const result = await audit({ agent: 'bot' })

    expect(result.entries.map((entry) => entry.recordId)).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({ actor: { kind: 'admin', name: 'ann' }, action: 'files.grant' })
  })

  test('an edit with no named admin reads as unattributed', async () => {
    await write(ACCESS_EDIT_SESSION_ID, [
      {
        ...edit('2026-10-04T11:00:00.000Z', { action: 'files.root.add', path: data }),
        payload: { action: 'files.root.add', path: data, actor: { adminName: null, role: null, via: 'cli' } },
      },
    ])

    expect((await audit()).entries[0]?.actor).toEqual({ kind: 'admin', name: 'unattributed', via: 'cli' })
  })
})

describe('queryFileAudit — limit, truncation, bad records', () => {
  test('cuts to the limit, newest kept, and says there is more', async () => {
    await write('s1', [
      call({ ts: '2026-10-04T10:00:01.000Z', payload: { path: `${data}/1` } }),
      call({ ts: '2026-10-04T10:00:02.000Z', payload: { path: `${data}/2` } }),
      call({ ts: '2026-10-04T10:00:03.000Z', payload: { path: `${data}/3` } }),
    ])

    const result = await audit({ limit: 2 })

    expect(pathsOf(result.entries)).toEqual([[`${data}/3`], [`${data}/2`]])
    expect(result.hasMore).toBe(true)
  })

  test('equal timestamps order by record id, newest id first', async () => {
    await write('s1', [call({ payload: { path: `${data}/1` } }), call({ payload: { path: `${data}/2` } })])

    expect(pathsOf((await audit()).entries)).toEqual([[`${data}/2`], [`${data}/1`]])
  })

  test('propagates a truncated journal walk', async () => {
    const records = Array.from({ length: 1002 }, (_unused, index) =>
      call({ ts: `2026-10-04T10:00:00.${String(index % 1000).padStart(3, '0')}Z`, payload: { path: `${data}/${index}` } }),
    )
    await write('s1', records)

    const result = await audit({ limit: 10 })

    expect(result.truncated).toBe(true)
    expect(result.entries).toHaveLength(10)
  })

  test('an empty or missing journal is an empty answer', async () => {
    expect(await audit()).toEqual({ entries: [], hasMore: false, truncated: false })
  })

  test('malformed records are skipped, never thrown on', async () => {
    const broken = call({ payload: { path: `${data}/ok` } })
    await write('s1', [
      call({ payload: { path: `${data}/ok` } }),
      { ...broken, id: nextId(), decision: { ...(broken.decision as object), toolName: 7 } } as unknown as JournalRecord,
      { ...broken, id: nextId(), decision: undefined } as unknown as JournalRecord,
      { ...broken, id: nextId(), payload: 'text' } as unknown as JournalRecord,
    ])
    await write(ACCESS_EDIT_SESSION_ID, [
      edit('2026-10-04T11:00:00.000Z', { action: 42 }),
      { ...edit('2026-10-04T11:00:01.000Z', {}), payload: null },
      { ...edit('2026-10-04T11:00:02.000Z', { action: 'files.grant', path: 5 }), payload: { action: 'files.grant', path: 5, actor: 'ann' } },
    ])

    const result = await audit()

    expect(result.entries.map((entry) => entry.action).sort()).toEqual(['files.grant', 'read_file', 'read_file'])
    expect(result.entries.find((entry) => entry.action === 'files.grant')).toMatchObject({
      actor: { kind: 'admin', name: 'unattributed', via: 'unknown' },
      paths: [],
    })
  })
})

describe('queryFileAudit — other servers do not crowd out file calls', () => {
  test('finds a file call behind more than a page of decisions of another server', async () => {
    await write('s-files', [call({ ts: '2026-10-04T09:00:00.000Z', agent: 'bot', payload: { path: '/data/a.txt' } })])
    const noise = Array.from({ length: 1100 }, (_, index) =>
      call({ ts: `2026-10-04T10:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:00.000Z`, server: 'github', tool: 'list_issues' }),
    )
    await write('s-github', noise)

    const result = await audit()

    expect(pathsOf(result.entries)).toEqual([['/data/a.txt']])
    expect(result.truncated).toBe(false)
  })
})

describe('queryFileAudit — subject and path spellings', () => {
  test('an admin edit names the agent or the group it was for; an agent call names none', async () => {
    await write(ACCESS_EDIT_SESSION_ID, [
      edit('2026-10-04T10:00:00.000Z', { action: 'files.grant', agent: 'bot', path: '/data/a' }),
      edit('2026-10-04T11:00:00.000Z', { action: 'files.grant', group: 'devs', path: '/data/a' }),
    ])
    await write('s-1', [call({ ts: '2026-10-04T12:00:00.000Z', agent: 'bot', payload: { path: '/data/a' } })])

    const result = await audit()

    expect(result.entries.map((entry) => entry.subject)).toEqual([null, { kind: 'group', name: 'devs' }, { kind: 'agent', name: 'bot' }])
  })

  test('a path alias matches what was recorded under the other spelling', async () => {
    await write(ACCESS_EDIT_SESSION_ID, [edit('2026-10-04T10:00:00.000Z', { action: 'files.grant', agent: 'bot', path: '/private/tmp/a' })])

    const without = await queryFileAudit({ limit: 100, path: '/tmp/a/x' }, { dir, platform: 'linux' })
    const withAlias = await queryFileAudit({ limit: 100, path: '/tmp/a/x', pathAliases: ['/private/tmp/a/x'] }, { dir, platform: 'linux' })

    expect(without.entries).toEqual([])
    expect(pathsOf(withAlias.entries)).toEqual([['/private/tmp/a']])
  })
})

describe('an agent cannot bury a call under a flood of later calls', () => {
  test('a path query finds a delete made before more than a thousand newer file calls', async () => {
    const target = join(data, 'p', 'important.txt')
    const flood = Array.from({ length: 1_100 }, (_unused, index) =>
      call({ ts: '2026-10-04T11:00:00.000Z', agent: 'bot', outcome: 'deny', rule: 'files: outside-roots', payload: { path: `/elsewhere/${index}` } }),
    )
    await write('s-delete', [call({ ts: '2026-10-04T10:00:00.000Z', agent: 'bot', tool: 'delete_file', payload: { path: target } })])
    await write('s-flood', flood)

    const result = await audit({ path: target })

    expect(result.entries.map((entry) => [entry.action, entry.paths[0]])).toEqual([['delete_file', target]])
  })

  test('a Windows path is found through the JSON escaping of its backslashes', async () => {
    const target = 'C:\\data\\p\\important.txt'
    const flood = Array.from({ length: 1_100 }, (_unused, index) => call({ ts: '2026-10-04T11:00:00.000Z', payload: { path: `C:\\elsewhere\\${index}` } }))
    await write('s-delete', [call({ tool: 'delete_file', payload: { path: target } })])
    await write('s-flood', flood)

    const result = await queryFileAudit({ limit: 100, path: target }, { dir, platform: 'win32' })

    expect(result.entries.map((entry) => entry.action)).toEqual(['delete_file'])
  })
})

describe('whole-folder actions and many sessions do not hide a call either', () => {
  test('a delete of a folder holding the path is found under a flood, a listing of that folder is not mistaken for one', async () => {
    const folder = join(data, 'p', 'dir')
    const flood = Array.from({ length: 1_100 }, () => call({ ts: '2026-10-04T11:00:00.000Z', agent: 'bot', tool: 'list_directory', payload: { path: folder } }))
    await write('s-delete', [call({ ts: '2026-10-04T10:00:00.000Z', agent: 'bot', tool: 'delete_file', payload: { path: folder } })])
    await write('s-flood', flood)

    const result = await audit({ path: join(folder, 'report.md') })

    expect(result.entries.map((entry) => [entry.action, entry.paths[0]])).toEqual([['delete_file', folder]])
  })

  test('a call is found behind sixty newer sessions', async () => {
    const target = join(data, 'p', 'old.txt')
    await write('s-000', [call({ ts: '2026-10-04T09:00:00.000Z', agent: 'bot', tool: 'delete_file', payload: { path: target } })])
    for (let index = 1; index <= 60; index += 1) {
      await write(`s-${String(index).padStart(3, '0')}`, [call({ ts: `2026-10-04T10:${String(index).padStart(2, '0')}:00.000Z`, agent: 'bot', payload: { path: `/elsewhere/${index}` } })])
    }

    const result = await audit({ path: target })

    expect(result.entries.map((entry) => entry.action)).toEqual(['delete_file'])
  })
})
