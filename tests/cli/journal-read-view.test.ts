import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runSessionsCommand, runShowCommand, type JournalCliIo } from '../../src/cli/journal-cmds.js'
import { formatRecordsReadable } from '../../src/cli/session-view.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createJournalSink } from '../../src/journal/sink.js'

/**
 * First-minute readability of `show` and `sessions` (0.2.4, stranger run
 * 0.2.3 friction 5): the useful part of a decision row comes first, `show`
 * ends with the way to prove the session, `sessions` names server and agent.
 * Presentation only: the records themselves are untouched.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-read-view-test-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function fakeIo(): JournalCliIo & { readonly out: () => string; readonly err: () => string } {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

function decisionRecord(
  sessionId: string,
  toolName: string,
  payload: unknown,
  extra: Record<string, unknown> = {},
): JournalRecord {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
    ts: '2026-08-05T00:00:00.000Z',
    sessionId,
    direction: 'client→server',
    kind: 'decision',
    payload,
    decision: {
      outcome: 'allow',
      rule: 'classDefaults.read',
      serverName: 'fs',
      toolName,
      toolClass: 'read',
      quarantineState: 'known',
      argsHash: 'abc123',
      ...extra,
    },
  } as unknown as JournalRecord
}

async function writeRecords(sessionId: string, records: readonly JournalRecord[]): Promise<void> {
  const sink = createJournalSink(sessionId, { dir: journalDir })
  records.forEach((record) => sink.write(record))
  await sink.close()
}

describe('show: decision rows lead with the verdict', () => {
  test('outcome, tool and rule come before the arguments JSON', () => {
    const line = formatRecordsReadable([decisionRecord('S1', 'read_text_file', { path: '/tmp/notes.txt' })])

    expect(line.indexOf('outcome=allow')).toBeGreaterThan(-1)
    expect(line.indexOf('outcome=allow')).toBeLessThan(line.indexOf('{"path"'))
    expect(line.indexOf('rule=classDefaults.read')).toBeLessThan(line.indexOf('{"path"'))
    expect(line.endsWith('\n')).toBe(true)
  })

  test('a tools/list decision says how many tools instead of printing the array first', () => {
    const tools = Array.from({ length: 14 }, (_, index) => `tool_${index}`)
    const line = formatRecordsReadable([decisionRecord('S1', 'tools/list', { tools })])

    expect(line).toContain('outcome=allow tool=tools/list')
    expect(line).toContain('14 tools')
    expect(line.indexOf('14 tools')).toBeLessThan(line.indexOf('tool_0'))
    expect(line).not.toContain('{"tools"')
  })

  test('a decision without arguments does not print an empty JSON tail', () => {
    const line = formatRecordsReadable([decisionRecord('S1', 'ping', undefined)])

    expect(line).toContain('outcome=allow tool=ping')
    expect(line).not.toContain('undefined')
  })

  test('non-decision rows keep their layout', () => {
    const request = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FA2',
      ts: '2026-08-05T00:00:01.000Z',
      sessionId: 'S1',
      direction: 'client→server',
      kind: 'request',
      method: 'tools/list',
      payload: { id: 1 },
    } as JournalRecord

    expect(formatRecordsReadable([request])).toBe(
      '2026-08-05T00:00:01.000Z  client→server   request       tools/list        {"id":1}\n',
    )
  })
})

describe('show: ends with the next step', () => {
  test('prints the export --report command for this session on stderr', async () => {
    await writeRecords('S-one', [decisionRecord('S-one', 'read_text_file', { path: '/x' })])
    const io = fakeIo()

    const exitCode = await runShowCommand(['S-one'], io, journalDir)

    expect(exitCode).toBe(0)
    expect(io.err()).toContain('Prove it: mcpcut export --report --session S-one --out ./mcpcut-report')
    expect(io.out()).not.toContain('Prove it')
  })

  test('--json keeps stderr free of the hint', async () => {
    await writeRecords('S-one', [decisionRecord('S-one', 'read_text_file', { path: '/x' })])
    const io = fakeIo()

    await runShowCommand(['S-one', '--json'], io, journalDir)

    expect(io.err()).not.toContain('Prove it')
  })
})

describe('sessions: server and agent columns', () => {
  test('keeps the first four columns and appends server and agent', async () => {
    await writeRecords('S-agent', [decisionRecord('S-agent', 'a', {}, { agentName: 'claude-code' })])
    const io = fakeIo()

    await runSessionsCommand(io, journalDir)

    const [header, row] = io.out().split('\n')
    expect(header?.split(/\s+/)).toEqual(['sessionId', 'firstTs', 'lastTs', 'messages', 'server', 'agent'])
    expect(row?.split(/\s+/)).toEqual(['S-agent', '2026-08-05T00:00:00.000Z', '2026-08-05T00:00:00.000Z', '1', 'fs', 'claude-code'])
  })

  test('shows - for an agent a wrap session never had, and for a session with no decision', async () => {
    await writeRecords('S-wrap', [decisionRecord('S-wrap', 'a', {})])
    await writeRecords('S-bare', [
      { ...decisionRecord('S-bare', 'a', {}), kind: 'request', decision: undefined } as JournalRecord,
    ])
    const io = fakeIo()

    await runSessionsCommand(io, journalDir)

    const rows = io.out().split('\n').slice(1).filter((line) => line !== '')
    const wrap = rows.find((line) => line.startsWith('S-wrap'))?.split(/\s+/)
    const bare = rows.find((line) => line.startsWith('S-bare'))?.split(/\s+/)
    expect(wrap?.slice(4)).toEqual(['fs', '-'])
    expect(bare?.slice(4)).toEqual(['-', '-'])
  })

  test('a pool session takes its agent and members from its pool record', async () => {
    const pool = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FA3',
      ts: '2026-08-05T00:00:00.000Z',
      sessionId: 'S-pool',
      direction: 'client→server',
      kind: 'pool',
      method: 'pool/open',
      payload: { agentName: 'cursor', event: 'open', members: ['fs', 'github'] },
    } as unknown as JournalRecord
    await writeRecords('S-pool', [pool])
    const io = fakeIo()

    await runSessionsCommand(io, journalDir)

    const row = io.out().split('\n')[1]?.split(/\s+/)
    expect(row?.slice(4)).toEqual(['fs,github', 'cursor'])
  })
})
