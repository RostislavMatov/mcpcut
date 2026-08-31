import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { journalAccessEdit } from '../../src/groups/journal-access-edit.js'
import {
  ACCESS_EDIT_SESSION_ID,
  type AccessEditInfo,
} from '../../src/journal/access-edit-record.js'
import { readSessionWithStats } from '../../src/journal/reader.js'

/**
 * `journalAccessEdit` writes one `access-edit` record through the standard
 * sink under the reserved session (plan m55-server-groups Task 8) and NEVER
 * throws — the sibling of `journalPolicyEdit`, pinned the same way: the
 * access change already happened in the store when this runs, so an
 * unreachable journal must not turn a completed change into a failed command.
 */

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-journal-access-edit-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const INFO: AccessEditInfo = {
  actor: { adminName: 'alice', role: 'owner', via: 'ui' },
  action: 'group.join',
  group: 'analytics',
  agent: 'ci-agent',
}

describe('journalAccessEdit', () => {
  test('writes exactly one access-edit record readable back under the reserved session', async () => {
    const outcome = await journalAccessEdit({ info: INFO, dir, clock: () => Date.UTC(2026, 7, 31) })

    expect(outcome).toEqual({ written: true, droppedCount: 0 })
    const read = await readSessionWithStats(ACCESS_EDIT_SESSION_ID, { dir })
    expect(read.skippedLineCount).toBe(0)
    expect(read.records).toHaveLength(1)
    const record = read.records[0]
    expect(record?.kind).toBe('access-edit')
    expect(record?.sessionId).toBe(ACCESS_EDIT_SESSION_ID)
    expect(record?.payload).toEqual({
      actor: { adminName: 'alice', role: 'owner', via: 'ui' },
      action: 'group.join',
      group: 'analytics',
      agent: 'ci-agent',
    })
  })

  test('an unwritable journal directory is a drop, not a throw', async () => {
    const lines: string[] = []

    const outcome = await journalAccessEdit({
      info: INFO,
      dir: join(dir, 'missing', 'nested', '\0bad'),
      diagnostics: (line) => lines.push(line),
    })

    expect(outcome.written).toBe(false)
    expect(outcome.droppedCount).toBe(1)
    expect(lines.join('')).toContain('access-edit')
  })

  test('a failing commit is reported as a drop on the diagnostics sink, never thrown', async () => {
    const lines: string[] = []

    const outcome = await journalAccessEdit({
      info: INFO,
      dir,
      diagnostics: (line) => lines.push(line),
      sinkOptions: {
        retryDelayMs: 0,
        commitBatchImpl: () => {
          throw new Error('disk on fire')
        },
      },
    })

    expect(outcome.written).toBe(false)
    expect(outcome.droppedCount).toBe(1)
    expect(lines.join('')).toContain('access-edit')
  })
})
