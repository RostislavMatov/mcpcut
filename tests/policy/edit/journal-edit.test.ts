import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { journalDbPathFor, openJournalDbShared } from '../../../src/journal/db.js'
import { POLICY_EDIT_SESSION_ID, type PolicyEditInfo } from '../../../src/journal/policy-edit-record.js'
import { journalPolicyEdit } from '../../../src/policy/edit/journal-edit.js'

/**
 * `journalPolicyEdit` writes one `policy-edit` record through the standard
 * sink under the reserved session (O5) and never throws — the sibling of
 * `journalProbe`, pinned the same way.
 */

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-journal-edit-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const EDIT: PolicyEditInfo = {
  actor: { adminName: 'alice', role: 'owner', via: 'ui' },
  serverName: 'github',
  toolName: 'create_issue',
  rule: 'deny',
  policyHashBefore: 'a'.repeat(64),
  policyHashAfter: 'b'.repeat(64),
  sourcePath: '/state/policy.json',
}

async function storedRecords(): Promise<{ sessionId: string; kind: string; doc: string }[]> {
  const handle = await openJournalDbShared(journalDbPathFor(dir))
  return handle.db
    .prepare('SELECT session_id AS sessionId, kind, doc FROM journal_records ORDER BY seq')
    .all() as { sessionId: string; kind: string; doc: string }[]
}

describe('journalPolicyEdit', () => {
  test('writes exactly one policy-edit record under the reserved session', async () => {
    const outcome = await journalPolicyEdit({ edit: EDIT, dir, clock: () => Date.UTC(2026, 7, 25) })

    expect(outcome).toEqual({ written: true, droppedCount: 0 })
    const rows = await storedRecords()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sessionId).toBe(POLICY_EDIT_SESSION_ID)
    expect(rows[0]?.kind).toBe('policy-edit')
    const doc = JSON.parse(rows[0]?.doc ?? '{}') as { payload: Record<string, unknown> }
    expect(doc.payload).toMatchObject({
      actor: { adminName: 'alice', role: 'owner', via: 'ui' },
      serverName: 'github',
      toolName: 'create_issue',
      rule: 'deny',
      policyHashBefore: EDIT.policyHashBefore,
      policyHashAfter: EDIT.policyHashAfter,
    })
  })

  test('a failing commit is reported as a drop on the diagnostics sink, never thrown', async () => {
    const lines: string[] = []

    const outcome = await journalPolicyEdit({
      edit: EDIT,
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
    expect(lines.join('')).toContain('policy-edit')
  })
})
