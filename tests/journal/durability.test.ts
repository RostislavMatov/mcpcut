import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { GENESIS_PREV_HASH, linkHashOf } from '../../src/journal/chain.js'
import { journalDbPathFor, openJournalDbShared } from '../../src/journal/db.js'

/**
 * Durability gate (M4.5 wave 4, ADR-0006, plan Task 8): `journal.db` runs
 * `synchronous=FULL` under WAL, so a commit `flush()` awaited must survive a
 * `kill -9`, not just a graceful shutdown. This is the one test in the suite
 * that actually kills a process mid-write to prove it: everything else
 * exercises the sink/writer through fault injection, not a real OS-level
 * death.
 *
 * The fixture (`fixtures/durability-child.mjs`, run from `dist/` — the real
 * built artifact, not a source stub) writes records through the real sink and
 * prints `confirmed:<count>` only AFTER `flush()` resolves. That ordering is
 * the contract under test: printed means durable. We SIGKILL the child right
 * after collecting a few confirmations, then reopen the db from this process
 * and check every record the child claimed as confirmed is actually there.
 *
 * Per the plan's GOTCHA, this asserts confirmed-is-a-subset, not
 * nothing-extra: records the child had buffered but never got to confirm may
 * legitimately die with it — that asymmetry IS the contract, not a gap.
 *
 * M5 wave 3, task 3.5: the same kill also proves the hash chain
 * (`journal/chain.ts`) survives a mid-write death. `insertRecordRows` folds
 * the chain across a whole batch inside ONE transaction, so a kill mid-batch
 * must leave either the whole batch committed or none of it — there is no
 * SQL-level way for a partial batch to land. This test re-derives
 * `linkHashOf` itself across every surviving row in `seq` order, deliberately
 * NOT calling `chain-verify.ts`'s walk (a concurrent M5 task): reusing the
 * verifier under test to check the verifier would hide a bug in it. Asserting
 * the STRONG property (every row's stored `prev_hash` matches the fold, not
 * just "no crash") is the point — a real partial-batch bug should fail this,
 * not be shrugged off as "acceptable data loss" the way the confirmed-subset
 * assertion above is for buffered-but-unflushed writes.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = join(__dirname, 'fixtures/durability-child.mjs')
const MIN_CONFIRMATIONS_BEFORE_KILL = 3
const TEST_TIMEOUT_MS = 20_000

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-durability-test-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

interface ChildRun {
  readonly child: ChildProcessWithoutNullStreams
  /** `payload.seq` counts confirmed so far, one entry per `confirmed:` line seen. */
  readonly confirmations: number[]
  stderrText: string
}

function spawnChild(dir: string): ChildRun {
  const child = spawn(process.execPath, [FIXTURE_PATH, dir], { stdio: ['ignore', 'pipe', 'pipe'] })
  const run: ChildRun = { child, confirmations: [], stderrText: '' }

  let stdoutBuffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8')
    const lines = stdoutBuffer.split('\n')
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const match = /^confirmed:(\d+)$/.exec(line)
      if (match?.[1] !== undefined) {
        run.confirmations.push(Number.parseInt(match[1], 10))
      }
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    run.stderrText += chunk.toString('utf8')
  })

  return run
}

/** Waits until at least `count` confirmations have been observed, or the child dies first. */
async function waitForConfirmations(run: ChildRun, count: number): Promise<void> {
  const deadline = Date.now() + TEST_TIMEOUT_MS - 2_000
  while (run.confirmations.length < count) {
    if (run.child.exitCode !== null || run.child.signalCode !== null) {
      throw new Error(
        `durability-child exited early (code=${String(run.child.exitCode)}, ` +
          `signal=${String(run.child.signalCode)}) after ${run.confirmations.length} ` +
          `confirmation(s); stderr:\n${run.stderrText}`,
      )
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${count} confirmations; got ${run.confirmations.length}; ` +
          `stderr:\n${run.stderrText}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => resolve())
  })
}

describe('journal durability: kill -9 after a confirmed flush loses nothing', () => {
  test(
    'every payload.seq the child confirmed is present in journal.db after SIGKILL',
    async () => {
      const run = spawnChild(journalDir)

      await waitForConfirmations(run, MIN_CONFIRMATIONS_BEFORE_KILL)
      const lastConfirmed = run.confirmations[run.confirmations.length - 1]
      if (lastConfirmed === undefined) {
        throw new Error('no confirmation recorded before kill')
      }

      // Mid-stream: do not wait for the fixture's infinite loop to reach any
      // natural boundary. This is the whole point of the test.
      if (run.child.pid !== undefined) {
        process.kill(run.child.pid, 'SIGKILL')
      }
      await waitForExit(run.child)

      const handle = await openJournalDbShared(journalDbPathFor(journalDir))
      const rows = handle.db
        .prepare('SELECT doc FROM journal_records WHERE session_id = ? ORDER BY seq')
        .all('durability-child') as { doc: string }[]
      const confirmedSeqs = new Set(
        rows.map((row) => (JSON.parse(row.doc) as { payload: { seq: number } }).payload.seq),
      )

      expect(rows.length).toBeGreaterThanOrEqual(lastConfirmed)
      for (let seq = 0; seq < lastConfirmed; seq += 1) {
        expect(confirmedSeqs.has(seq)).toBe(true)
      }

      // Chain check: re-derive every link ourselves across the WHOLE
      // database in `seq` order (the chain head query in `db.ts` is
      // global, not per-session — this journalDir has exactly one writer,
      // but the check still walks unscoped to match that invariant). A
      // survived-but-broken batch (a real bug) fails here even though the
      // confirmed-subset assertion above would have missed it entirely.
      const chainRows = handle.db
        .prepare(
          'SELECT doc, prev_hash AS prevHash, record_hash AS recordHash FROM journal_records ORDER BY seq',
        )
        .all() as { doc: string; prevHash: string | null; recordHash: string | null }[]

      let expectedPrev: string = GENESIS_PREV_HASH
      for (const row of chainRows) {
        expect(row.prevHash).toBe(expectedPrev)
        const expectedRecordHash = linkHashOf(expectedPrev, row.doc)
        expect(row.recordHash).toBe(expectedRecordHash)
        expectedPrev = expectedRecordHash
      }
    },
    TEST_TIMEOUT_MS,
  )
})
