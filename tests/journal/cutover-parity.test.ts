import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runExportCommand } from '../../src/cli/export-cmd.js'
import { runSessionsCommand, runShowCommand } from '../../src/cli/journal-cmds.js'
import { runMigrateCommand } from '../../src/cli/migrate-cmd.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { searchAllSessions } from '../../src/journal/search.js'
import { createJournalSink } from '../../src/journal/sink.js'
import { readJournalRecords } from '../support/journal-rows.js'

/**
 * The M4.5 phase-5 gate, as a test: an installation whose journal was WRITTEN
 * into `journal.db` and one whose identical records were MIGRATED out of
 * legacy `*.jsonl` files must be indistinguishable through every read surface
 * the plane offers — `sessions`, `show --json`, `export` (whole journal and
 * per session) and the UI's `searchAllSessions`.
 *
 * That is the promise the cutover makes to an operator upgrading from M4:
 * `mcp-journal migrate` restores their journal to exactly the state a fresh
 * install would have had, losslessly, with no residue of which carrier the
 * records arrived through. If any pair below diverges, the cutover is wrong —
 * the assertion is not to be relaxed.
 *
 * Determinism is arranged, not hoped for. Both directories get the SAME record
 * objects, so `doc` (the pre-DB record, serialized) is byte-identical on both
 * sides; every session carries explicit, distinct timestamps, which fixes the
 * `lastTs`-ordered session listing; and the legacy files are stamped with
 * explicit, ascending mtimes, because `migrate` imports oldest-modified first
 * and that is what fixes `seq` — and therefore export order and the
 * newest-first search walk — to the order the fresh sink wrote in.
 */

/** `show`'s usage text is irrelevant here; only the happy path is exercised. */
const USAGE = 'Usage: mcp-journal show <sessionId>\n'

/** Base mtime for the legacy files; each file is stamped one second later than the previous. */
const LEGACY_MTIME_BASE_MS = Date.UTC(2026, 7, 14, 12, 0, 0)
const LEGACY_MTIME_STEP_MS = 1_000

/** Substring present in two of the three sessions — the cross-session needle. */
const CROSS_SESSION_NEEDLE = 'quarterly'

interface SessionFixture {
  readonly sessionId: string
  readonly records: readonly JournalRecord[]
}

const ALPHA: SessionFixture = {
  sessionId: 'parity-alpha',
  records: [
    {
      id: '01ALPHAREQUEST0000000000AA',
      ts: '2026-08-14T09:00:00.000Z',
      sessionId: 'parity-alpha',
      direction: 'client→server',
      kind: 'request',
      method: 'tools/call',
      rpcId: 1,
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_issue', arguments: { title: 'quarterly audit evidence' } },
      },
    },
    {
      id: '01ALPHADECISION000000000AB',
      ts: '2026-08-14T09:00:00.500Z',
      sessionId: 'parity-alpha',
      direction: 'client→server',
      kind: 'decision',
      method: 'tools/call',
      payload: { name: 'create_issue', arguments: { title: 'quarterly audit evidence' } },
      decision: {
        outcome: 'require-approval-pending',
        rule: 'tool:github/create_issue',
        serverName: 'github',
        toolName: 'create_issue',
        toolClass: 'write',
        quarantineState: 'known',
        argsHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        approvalId: '01APPROVALAAAAAAAAAAAAAAAA',
        agentName: 'research-bot',
      },
    },
    {
      id: '01ALPHARESPONSE000000000AC',
      ts: '2026-08-14T09:00:02.000Z',
      sessionId: 'parity-alpha',
      direction: 'server→client',
      kind: 'response',
      rpcId: 1,
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'issue #41 created' }] },
      },
      durationMs: 2000,
    },
    {
      id: '01ALPHASTDERR00000000000AD',
      ts: '2026-08-14T09:00:03.000Z',
      sessionId: 'parity-alpha',
      direction: 'server-stderr',
      kind: 'stderr',
      payload: 'github-mcp: warn: secondary rate limit at 80%',
    },
  ],
}

const BRAVO: SessionFixture = {
  sessionId: 'parity-bravo',
  records: [
    {
      id: '01BRAVONOTIFICATION00000BA',
      ts: '2026-08-14T10:00:00.000Z',
      sessionId: 'parity-bravo',
      direction: 'client→server',
      kind: 'notification',
      method: 'notifications/initialized',
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    },
    {
      id: '01BRAVODECISION000000000BB',
      ts: '2026-08-14T10:00:01.000Z',
      sessionId: 'parity-bravo',
      direction: 'client→server',
      kind: 'decision',
      method: 'tools/call',
      payload: { name: 'delete_repo', arguments: { owner: 'acme', repo: 'ledger' } },
      decision: {
        outcome: 'deny',
        rule: 'class:destructive',
        serverName: 'github',
        toolName: 'delete_repo',
        toolClass: 'destructive',
        quarantineState: 'new',
        argsHash: '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
        latencyMs: 3,
      },
    },
    {
      id: '01BRAVORESPONSE000000000BC',
      ts: '2026-08-14T10:00:02.000Z',
      sessionId: 'parity-bravo',
      direction: 'server→client',
      kind: 'response',
      rpcId: 7,
      payload: {
        jsonrpc: '2.0',
        id: 7,
        error: { code: -32000, message: 'denied by policy' },
      },
      durationMs: 12,
    },
  ],
}

const CHARLIE: SessionFixture = {
  sessionId: 'parity-charlie',
  records: [
    {
      id: '01CHARLIEREQUEST00000000CA',
      ts: '2026-08-14T11:00:00.000Z',
      sessionId: 'parity-charlie',
      direction: 'client→server',
      kind: 'request',
      method: 'tools/list',
      rpcId: 'req-2',
      payload: {
        jsonrpc: '2.0',
        id: 'req-2',
        method: 'tools/list',
        params: { cursor: 'quarterly-page-2' },
      },
    },
    {
      id: '01CHARLIERESPONSE0000000CB',
      ts: '2026-08-14T11:00:01.000Z',
      sessionId: 'parity-charlie',
      direction: 'server→client',
      kind: 'response',
      rpcId: 'req-2',
      payload: { jsonrpc: '2.0', id: 'req-2', result: { tools: [{ name: 'create_issue' }] } },
      durationMs: 41,
    },
  ],
}

/**
 * Write order for the fresh journal and mtime order for the legacy files —
 * the same order, so `seq` agrees between the two carriers. Timestamps ascend
 * with it, so the `lastTs`-ordered listing is charlie, bravo, alpha in both.
 */
const FIXTURES: readonly SessionFixture[] = [ALPHA, BRAVO, CHARLIE]

let freshDir: string
let migratedDir: string

beforeEach(async () => {
  freshDir = await mkdtemp(join(tmpdir(), 'mcp-journal-parity-fresh-'))
  migratedDir = await mkdtemp(join(tmpdir(), 'mcp-journal-parity-legacy-'))
  await writeFreshJournal(freshDir)
  await writeLegacyJournalAndMigrate(migratedDir)
})

afterEach(async () => {
  await rm(freshDir, { recursive: true, force: true })
  await rm(migratedDir, { recursive: true, force: true })
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

/** (A) The fresh install: every record goes in through the real sink, session by session. */
async function writeFreshJournal(dir: string): Promise<void> {
  for (const fixture of FIXTURES) {
    const sink = createJournalSink(fixture.sessionId, { dir })
    for (const record of fixture.records) {
      sink.write(record)
    }
    // Closed before the next session starts, so `seq` follows FIXTURES order.
    await sink.close()
  }
}

/** (B) The upgraded install: the same records as legacy JSONL, then `mcp-journal migrate`. */
async function writeLegacyJournalAndMigrate(dir: string): Promise<void> {
  for (const [index, fixture] of FIXTURES.entries()) {
    const filePath = join(dir, `${fixture.sessionId}.jsonl`)
    const lines = fixture.records.map((record) => JSON.stringify(record))
    await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8')
    const stamp = new Date(LEGACY_MTIME_BASE_MS + index * LEGACY_MTIME_STEP_MS)
    await utimes(filePath, stamp, stamp)
  }

  const io = fakeIo()
  const exitCode = await runMigrateCommand([], io, { journalDir: dir })
  expect(exitCode, `migrate failed: ${io.err()}`).toBe(0)
  expect(io.out()).toContain(
    `journal: *.jsonl -> imported (${totalRecordCount()} records from ${FIXTURES.length} sessions)`,
  )
}

function totalRecordCount(): number {
  return FIXTURES.reduce((total, fixture) => total + fixture.records.length, 0)
}

interface CommandOutcome {
  readonly exitCode: number
  readonly out: string
  readonly err: string
}

async function runSessions(journalDir: string): Promise<CommandOutcome> {
  const io = fakeIo()
  const exitCode = await runSessionsCommand(io, journalDir)
  return { exitCode, out: io.out(), err: io.err() }
}

async function runShowJson(journalDir: string, sessionId: string): Promise<CommandOutcome> {
  const io = fakeIo()
  const exitCode = await runShowCommand([sessionId, '--json'], io, journalDir, USAGE)
  return { exitCode, out: io.out(), err: io.err() }
}

async function runExport(journalDir: string, args: readonly string[]): Promise<CommandOutcome> {
  const io = fakeIo()
  const exitCode = await runExportCommand(args, io, { journalDir })
  return { exitCode, out: io.out(), err: io.err() }
}

/**
 * The parity assertion itself: both sides succeeded, printed the same bytes,
 * and neither nudged the operator toward `migrate` — (A) has no legacy files
 * and (B)'s are fully imported.
 */
function expectParity(fresh: CommandOutcome, migrated: CommandOutcome): void {
  expect(fresh.exitCode).toBe(0)
  expect(migrated.exitCode).toBe(0)
  expect(migrated.out).toBe(fresh.out)
  expect(fresh.err).toBe('')
  expect(migrated.err).toBe('')
}

describe('cutover parity: the records themselves', () => {
  test('both journals hold the same records, per session and in the same global order', async () => {
    const freshAll = await readJournalRecords(freshDir)
    const migratedAll = await readJournalRecords(migratedDir)

    expect(freshAll).toEqual(FIXTURES.flatMap((fixture) => [...fixture.records]))
    expect(migratedAll).toEqual(freshAll)

    for (const fixture of FIXTURES) {
      const freshSession = await readJournalRecords(freshDir, fixture.sessionId)
      const migratedSession = await readJournalRecords(migratedDir, fixture.sessionId)
      expect(freshSession).toEqual([...fixture.records])
      expect(migratedSession).toEqual(freshSession)
    }
  })
})

describe('cutover parity: mcp-journal sessions', () => {
  test('prints an identical session table for a fresh and a migrated journal, with no legacy hint', async () => {
    const fresh = await runSessions(freshDir)
    const migrated = await runSessions(migratedDir)

    expectParity(fresh, migrated)
    // Guards the parity above from being vacuously true on empty output.
    for (const fixture of FIXTURES) {
      expect(fresh.out).toContain(fixture.sessionId)
    }
    expect(fresh.out).toContain(`${ALPHA.records.length}\n`)
  })
})

describe('cutover parity: mcp-journal show --json', () => {
  test.each(FIXTURES.map((fixture) => fixture.sessionId))(
    'prints identical records for session %s',
    async (sessionId) => {
      const fresh = await runShowJson(freshDir, sessionId)
      const migrated = await runShowJson(migratedDir, sessionId)

      expectParity(fresh, migrated)
      const lines = fresh.out.trimEnd().split('\n')
      const fixture = FIXTURES.find((candidate) => candidate.sessionId === sessionId)
      expect(lines).toHaveLength(fixture?.records.length ?? 0)
    },
  )
})

describe('cutover parity: mcp-journal export', () => {
  test('the whole journal exports identical JSONL, in the same order', async () => {
    const fresh = await runExport(freshDir, [])
    const migrated = await runExport(migratedDir, [])

    expectParity(fresh, migrated)
    const lines = fresh.out.trimEnd().split('\n')
    expect(lines).toHaveLength(totalRecordCount())
    // Order is `seq` order, which both carriers were arranged to agree on.
    expect(lines.map((line) => (JSON.parse(line) as JournalRecord).id)).toEqual(
      FIXTURES.flatMap((fixture) => fixture.records.map((record) => record.id)),
    )
  })

  test.each(FIXTURES.map((fixture) => fixture.sessionId))(
    '--session %s exports identical JSONL',
    async (sessionId) => {
      const fresh = await runExport(freshDir, ['--session', sessionId])
      const migrated = await runExport(migratedDir, ['--session', sessionId])

      expectParity(fresh, migrated)
      const fixture = FIXTURES.find((candidate) => candidate.sessionId === sessionId)
      expect(fresh.out.trimEnd().split('\n')).toHaveLength(fixture?.records.length ?? 0)
    },
  )
})

describe('cutover parity: searchAllSessions (the UI port)', () => {
  test('a needle spanning two sessions returns structurally equal results', async () => {
    const fresh = await searchAllSessions({ dir: freshDir, text: CROSS_SESSION_NEEDLE })
    const migrated = await searchAllSessions({ dir: migratedDir, text: CROSS_SESSION_NEEDLE })

    expect(migrated).toEqual(fresh)
    // The needle must actually span sessions, or the parity above proves little.
    expect(new Set(fresh.hits.map((hit) => hit.sessionId))).toEqual(
      new Set([ALPHA.sessionId, CHARLIE.sessionId]),
    )
    expect(fresh.filesTotal).toBe(FIXTURES.length)
    expect(fresh.filesScanned).toBe(FIXTURES.length)
    expect(fresh.truncated).toBe(false)
    expect(fresh.stoppedBy).toBeNull()
  })

  test('an unfiltered walk returns every record of both journals identically', async () => {
    const fresh = await searchAllSessions({ dir: freshDir })
    const migrated = await searchAllSessions({ dir: migratedDir })

    expect(migrated).toEqual(fresh)
    expect(fresh.hits).toHaveLength(totalRecordCount())
    // Newest session first — the walk order both carriers were arranged to agree on.
    expect(fresh.hits.map((hit) => hit.sessionId)).toEqual(
      [...FIXTURES].reverse().flatMap((fixture) => fixture.records.map(() => fixture.sessionId)),
    )
  })
})
