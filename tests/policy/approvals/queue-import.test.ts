import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { migrateApprovalsQueue } from '../../../src/policy/approvals/queue-import.js'
import { openApprovalsDb, type ApprovalsDb } from '../../../src/policy/approvals/queue-db.js'
import { createApprovalQueue } from '../../../src/policy/approvals/queue.js'
import { checkRecentApproval } from '../../../src/policy/approvals/grants.js'

/**
 * The legacy import's ONE-OUTCOME-PER-ID guarantee: an approval id that a
 * hand-copied installation left in BOTH `pending/` and `resolved/` (the M4.5
 * README tells operators to `cp -p` those directories around) must import as
 * the SETTLED record, never as an open request. A denial that comes back
 * approvable is the invariant this file exists to nail down.
 *
 * Fixture style follows the import tests in `queue-db.test.ts`: a real temp
 * journal directory, hand-written legacy JSON files, and the ordinary
 * first-touch open (`openApprovalsDb` / `createApprovalQueue`) as the trigger.
 */

let journalDir: string
let baseDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-approvals-import-test-'))
  baseDir = join(journalDir, 'approvals')
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

/** Ids are ULIDs, so ascending string order is ascending request order. */
const ID_A = '01AAAAAAAAAAAAAAAAAAAAAAAA'
const ID_B = '01BBBBBBBBBBBBBBBBBBBBBBBB'
const ID_C = '01CCCCCCCCCCCCCCCCCCCCCCCC'

interface ResolutionSeed {
  readonly outcome: 'approved' | 'denied' | 'expired'
  readonly actor?: string
  readonly reason?: string
}

function legacyDoc(approvalId: string, resolution?: ResolutionSeed): string {
  const iso = new Date().toISOString()
  return JSON.stringify({
    approvalId,
    serverName: 'github',
    toolName: 'create_issue',
    toolClass: 'write',
    argsRedacted: { title: 'hello' },
    argsHash: 'hash-1',
    sessionId: 'session-1',
    requestedAt: iso,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...(resolution === undefined ? {} : { resolution, resolvedAt: iso }),
  })
}

async function writeLegacyFile(subdir: string, approvalId: string, content: string): Promise<void> {
  await mkdir(join(baseDir, subdir), { recursive: true })
  await writeFile(join(baseDir, subdir, `${approvalId}.json`), content, 'utf8')
}

/** The dangerous shape: the SAME id left behind in both directories. */
async function seedDuplicatedId(id: string, resolution: ResolutionSeed): Promise<void> {
  await writeLegacyFile('resolved', id, legacyDoc(id, resolution))
  await writeLegacyFile('pending', id, legacyDoc(id))
}

function storedRows(db: ApprovalsDb): { approval_id: string; status: string; change_seq: number }[] {
  return db.handle.db
    .prepare('SELECT approval_id, status, change_seq FROM approvals ORDER BY change_seq')
    .all() as { approval_id: string; status: string; change_seq: number }[]
}

describe('importLegacyApprovals: an id present in both pending/ and resolved/', () => {
  test('imports as the settled record, not as an open request', async () => {
    await seedDuplicatedId(ID_B, { outcome: 'denied', actor: 'alice', reason: 'nope' })
    const queue = createApprovalQueue({ baseDir })

    const resolution = await queue.readResolution(ID_B)
    const pending = await queue.list()

    expect(resolution?.outcome).toBe('denied')
    expect(pending.map((entry) => entry.approvalId)).not.toContain(ID_B)
  })

  test('a denial duplicated into pending/ cannot be approved after the import', async () => {
    await seedDuplicatedId(ID_B, { outcome: 'denied', actor: 'alice', reason: 'nope' })
    const queue = createApprovalQueue({ baseDir })

    const reApproval = await queue.resolve(ID_B, { outcome: 'approved', actor: 'mallory' })

    expect(reApproval.ok).toBe(false)
    await expect(queue.readResolution(ID_B)).resolves.toMatchObject({ outcome: 'denied' })
  })

  test('migrate reports counts matching what the database actually holds', async () => {
    await seedDuplicatedId(ID_B, { outcome: 'denied', actor: 'alice' })
    await writeLegacyFile('pending', ID_A, legacyDoc(ID_A))

    const report = await migrateApprovalsQueue(journalDir)

    const rows = storedRows(await openApprovalsDb(baseDir))
    const storedByStatus = (status: string): number =>
      rows.filter((row) => row.status === status).length
    expect(report.status).toBe('imported')
    expect(report.pendingCount).toBe(storedByStatus('pending'))
    expect(report.resolvedCount).toBe(storedByStatus('resolved'))
    // …and the storage itself is what the invariant demands: one row, settled.
    expect(rows.map((row) => [row.approval_id, row.status])).toEqual([
      [ID_A, 'pending'],
      [ID_B, 'resolved'],
    ])
  })
})

describe('importLegacyApprovals: a settled record that cannot be parsed', () => {
  /** Truncated mid-write: the shape most likely to survive a crash or a bad `cp`. */
  const TRUNCATED = '{"approvalId":"01BBBBBBBBBBBBBBBBBBBBBBBB","serverName":"git'

  /** Shape-valid as a PENDING record, but with no `resolution` — so
   * `isResolvedApprovalFile` rejects it even though the JSON parses. */
  function settledWithoutOutcome(approvalId: string): string {
    return legacyDoc(approvalId)
  }

  test('a truncated settled record with a pending twin is NOT approvable after the import', async () => {
    await writeLegacyFile('resolved', ID_B, TRUNCATED)
    await writeLegacyFile('pending', ID_B, legacyDoc(ID_B))
    const queue = createApprovalQueue({ baseDir })

    const reApproval = await queue.resolve(ID_B, { outcome: 'approved', actor: 'mallory' })

    expect(reApproval.ok).toBe(false)
    await expect(queue.list()).resolves.toEqual([])
  })

  test('a settled record missing its outcome, with a pending twin, is inert but visible', async () => {
    await writeLegacyFile('resolved', ID_B, settledWithoutOutcome(ID_B))
    await writeLegacyFile('pending', ID_B, legacyDoc(ID_B))
    const queue = createApprovalQueue({ baseDir })

    const resolution = await queue.readResolution(ID_B)

    // Inert: settled, so nothing can approve it. Visible: it is still a record
    // an operator can find, not a row that quietly vanished.
    expect(resolution?.outcome).toBe('expired')
    await expect(queue.list()).resolves.toEqual([])
    await expect(queue.listResolved({ limit: 10 })).resolves.toHaveLength(1)
  })

  test('the grant window is not reopened by an unreadable settled record', async () => {
    await writeLegacyFile('resolved', ID_B, TRUNCATED)
    await writeLegacyFile('pending', ID_B, legacyDoc(ID_B))
    createApprovalQueue({ baseDir })

    const granted = await checkRecentApproval(baseDir, {
      serverName: 'github',
      toolName: 'create_issue',
      argsHash: 'hash-1',
      sessionId: 'session-1', // the legacy document's own session (requester binding, audit 2026-09-02 F1)
      ttlMs: 60_000,
      clock: () => Date.now(),
    })

    expect(granted).toBeNull()
  })

  test('an unreadable settled record with NO twin is a lost record, not a resurrection', async () => {
    // The asymmetry: nothing readable exists for this id anywhere, so there is
    // no request to make inert — only a record to report as unreadable.
    await writeLegacyFile('resolved', ID_C, TRUNCATED)
    await writeLegacyFile('pending', ID_A, legacyDoc(ID_A))

    const report = await migrateApprovalsQueue(journalDir)

    const rows = storedRows(await openApprovalsDb(baseDir))
    expect(rows.map((row) => row.approval_id)).toEqual([ID_A])
    expect(report.unreadableSettledCount).toBe(1)
    expect(report.pendingCount).toBe(1)
    expect(report.resolvedCount).toBe(0)
  })

  test('migrate reports unreadable settled records, and counts the inert row as resolved', async () => {
    await writeLegacyFile('resolved', ID_B, TRUNCATED)
    await writeLegacyFile('pending', ID_B, legacyDoc(ID_B))
    await writeLegacyFile('pending', ID_A, legacyDoc(ID_A))

    const report = await migrateApprovalsQueue(journalDir)

    const rows = storedRows(await openApprovalsDb(baseDir))
    expect(report.unreadableSettledCount).toBe(1)
    expect(report.pendingCount).toBe(rows.filter((row) => row.status === 'pending').length)
    expect(report.resolvedCount).toBe(rows.filter((row) => row.status === 'resolved').length)
    expect(rows.map((row) => [row.approval_id, row.status])).toEqual([
      [ID_A, 'pending'],
      [ID_B, 'resolved'],
    ])
  })

  test('a clean import reports no unreadable settled records', async () => {
    await writeLegacyFile('pending', ID_A, legacyDoc(ID_A))

    await expect(migrateApprovalsQueue(journalDir)).resolves.toMatchObject({
      status: 'imported',
      unreadableSettledCount: 0,
    })
  })
})

describe('importLegacyApprovals: ordering of non-duplicate ids', () => {
  test('ascending ULID order becomes ascending change_seq, across both directories', async () => {
    await writeLegacyFile('pending', ID_A, legacyDoc(ID_A))
    await writeLegacyFile('resolved', ID_B, legacyDoc(ID_B, { outcome: 'approved', actor: 'alice' }))
    await writeLegacyFile('pending', ID_C, legacyDoc(ID_C))

    const rows = storedRows(await openApprovalsDb(baseDir))

    expect(rows.map((row) => row.approval_id)).toEqual([ID_A, ID_B, ID_C])
    expect(rows.map((row) => row.change_seq)).toEqual([1, 2, 3])
  })

  test('ordering survives a duplicate id sitting between two others', async () => {
    await writeLegacyFile('pending', ID_A, legacyDoc(ID_A))
    await seedDuplicatedId(ID_B, { outcome: 'denied', actor: 'alice' })
    await writeLegacyFile('pending', ID_C, legacyDoc(ID_C))

    const rows = storedRows(await openApprovalsDb(baseDir))

    expect(rows.map((row) => [row.approval_id, row.status])).toEqual([
      [ID_A, 'pending'],
      [ID_B, 'resolved'],
      [ID_C, 'pending'],
    ])
    // Strictly ascending, not contiguous: the ignored duplicate still consumes a
    // change sequence, and `changesSince` reads `change_seq > watermark`, so a
    // gap is invisible to every consumer. Ascending is the guarantee; 1,2,3 is not.
    const seqs = rows.map((row) => row.change_seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })
})
