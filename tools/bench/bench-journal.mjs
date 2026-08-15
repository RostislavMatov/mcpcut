#!/usr/bin/env node
// Reproducible journal-write/read benchmark behind ADR-0006 (Evidence table)
// and the M4.5 wave-4 PRD gates (journal-sqlite.plan.md, Task 9).
//
// Three modes, selected with --mode (default: legacy):
//
//   --mode legacy (default) — the ORIGINAL four arms, run unchanged:
//     1. "sink (was JSONL in ADR-0006 evidence)" — createJournalSink from dist/
//     2. SQLite WAL, batched transactions (synchronous=NORMAL)
//     3. SQLite WAL, batched transactions (synchronous=FULL)
//     4. same as 3 + sha256 hash chain per record (the M5 load)
//
//     CAVEAT (wave-4 relabeling): arm 1 was originally the pre-wave-4 JSONL
//     `appendFile` sink. As of wave 4, `dist/journal/sink.js` is itself
//     sqlite-backed (a facade over the shared batch writer from
//     `src/journal/batch-writer.ts`) — this script always imports
//     `createJournalSink` from `dist/`, so it now measures the NEW sink, not
//     JSONL. The label below says so explicitly. The historical JSONL
//     numbers this arm produced pre-wave-4 remain recorded in ADR-0006 and
//     are NOT reproducible from this script version — a real JSONL arm no
//     longer exists in the codebase to benchmark against. See --mode sink
//     for the real-sink throughput gate instead (Task 9's actual arm).
//
//   --mode sink — drives the REAL new `createJournalSink` (the batched
//     writer over `journal.db`, synchronous=FULL) to measure the PRD's
//     journal-write gate (>= 100 000 rec/s). `--sessions 1` (default)
//     exercises one sink; `--sessions N` exercises N sinks sharing one
//     writer in the same process (the `serve` daemon's production shape).
//
//   --mode search — measures the PRD's search gate (p95 < 50 ms) on
//     `--search-rows` records (default 1_000_000). Rows are generated FAST
//     by direct batched inserts (openJournalDbShared + insertRecordRows in
//     10 000-row transactions), NOT through the sink — this arm measures
//     reads, not writes. Rows spread across ~20 sessions with varying
//     method/kind so a method filter selects a real subset. Reports
//     p50/p95 (ms) for 100x searchSession (one session, method filter,
//     limit 100) and 20x searchAllSessions (method filter, default limits).
//     Row-generation time is printed separately from query latency.
//
// Usage:
//   npm run build   # NOT run by this script; dist/ must already be current
//   node tools/bench/bench-journal.mjs [--records 20000] [--sessions 1] [--batch 256]
//   node tools/bench/bench-journal.mjs --mode sink --records 100000 [--sessions 8]
//   node tools/bench/bench-journal.mjs --mode search --search-rows 1000000
//
// Caveat (also in the ADR): on macOS fsync does not flush the drive cache
// (that needs F_FULLFSYNC), so durable numbers on Linux/ext4 will be lower.
// Orders of magnitude are what this script is meant to reproduce.
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createJournalSink } from '../../dist/journal/sink.js'
import { insertRecordRows, journalDbPathFor, openJournalDbShared } from '../../dist/journal/db.js'
import { searchAllSessions, searchSession } from '../../dist/journal/search.js'
import { openSqlite } from '../../dist/store/sqlite.js'

const { values: args } = parseArgs({
  options: {
    mode: { type: 'string', default: 'legacy' },
    records: { type: 'string' },
    sessions: { type: 'string', default: '1' },
    batch: { type: 'string', default: '256' },
    'search-rows': { type: 'string', default: '1000000' },
  },
})
const MODE = args.mode
const SESSIONS = Number(args.sessions)
const BATCH = Number(args.batch)
const SEARCH_ROWS = Number(args['search-rows'])
/** `--mode sink` defaults to the PRD gate size; every other mode keeps the ADR-0006 default. */
const DEFAULT_RECORDS = MODE === 'sink' ? 100_000 : 20_000
const RECORDS = args.records !== undefined ? Number(args.records) : DEFAULT_RECORDS

/** ~380-byte record matching the shape the proxy writes (ADR-0006 measurement). */
function makeRecord(i, sessionId) {
  return {
    id: `01BENCH${String(i).padStart(19, '0')}`,
    ts: new Date().toISOString(),
    sessionId,
    direction: 'client->server',
    kind: 'request',
    method: 'tools/call',
    rpcId: i,
    payload: {
      name: 'search_files',
      arguments: {
        path: '/home/user/projects/example-repository/src/components',
        pattern: '*.test.ts',
        recursive: true,
        note: 'benchmark payload padding to reach a realistic record size xxxx',
      },
    },
  }
}

function report(label, count, elapsedMs) {
  const perSec = Math.round((count / elapsedMs) * 1000)
  console.log(`${label.padEnd(46)} ${String(perSec).padStart(9)} rec/s  (${count} records, ${Math.round(elapsedMs)} ms)`)
}

async function benchJsonlSink(dir) {
  const sessionIds = Array.from({ length: SESSIONS }, (_, s) => `bench${s}`)
  const sinks = sessionIds.map((id) => createJournalSink(id, { dir }))
  const start = performance.now()
  for (let i = 0; i < RECORDS; i += 1) {
    const s = i % SESSIONS
    sinks[s].write(makeRecord(i, sessionIds[s]))
  }
  await Promise.all(sinks.map((sink) => sink.close()))
  const elapsed = performance.now() - start
  // Relabeled honestly for wave 4 — see the top-of-file caveat: this arm now
  // drives the NEW sqlite-backed sink, not JSONL appendFile.
  report(`sink (was JSONL in ADR-0006 evidence), ${SESSIONS} session(s)`, RECORDS, elapsed)
}

const JOURNAL_TABLE = `
  CREATE TABLE IF NOT EXISTS journal (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    id         TEXT NOT NULL,
    ts         TEXT NOT NULL,
    session_id TEXT NOT NULL,
    method     TEXT,
    payload    TEXT NOT NULL,
    chain_hash TEXT
  )`

async function benchSqlite(dir, synchronous, withChain) {
  const suffix = withChain ? '-chain' : ''
  const handle = await openSqlite(join(dir, `journal-${synchronous}${suffix}.db`), { synchronous })
  handle.db.exec(JOURNAL_TABLE)
  const insert = handle.db.prepare(
    'INSERT INTO journal (id, ts, session_id, method, payload, chain_hash) VALUES (?, ?, ?, ?, ?, ?)',
  )

  let prevHash = ''
  const start = performance.now()
  for (let offset = 0; offset < RECORDS; offset += BATCH) {
    const size = Math.min(BATCH, RECORDS - offset)
    handle.transaction(() => {
      for (let i = offset; i < offset + size; i += 1) {
        const record = makeRecord(i, `bench${i % SESSIONS}`)
        const json = JSON.stringify(record.payload)
        let chainHash = null
        if (withChain) {
          chainHash = createHash('sha256').update(prevHash).update(json).digest('hex')
          prevHash = chainHash
        }
        insert.run(record.id, record.ts, record.sessionId, record.method, json, chainHash)
      }
    })
  }
  const elapsed = performance.now() - start
  const label = `SQLite WAL sync=${synchronous.toUpperCase()}, txn/${BATCH}${withChain ? ' + sha256 chain' : ''}`
  report(label, RECORDS, elapsed)
  handle.close()
}

async function runLegacyMode() {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-journal-bench-'))
  try {
    console.log(`journal bench: ${RECORDS} records, ${SESSIONS} session(s), batch ${BATCH}, node ${process.version}\n`)
    await benchJsonlSink(dir)
    await benchSqlite(dir, 'normal', false)
    await benchSqlite(dir, 'full', false)
    await benchSqlite(dir, 'full', true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Drives the REAL sink (Task 9's throughput gate arm): write RECORDS, then flush, over SESSIONS sinks sharing one writer. */
async function benchRealSink(dir) {
  const sessionIds = Array.from({ length: SESSIONS }, (_, s) => `sink-bench-${s}`)
  const sinks = sessionIds.map((id) => createJournalSink(id, { dir }))
  const start = performance.now()
  for (let i = 0; i < RECORDS; i += 1) {
    const s = i % SESSIONS
    sinks[s].write(makeRecord(i, sessionIds[s]))
  }
  await Promise.all(sinks.map((sink) => sink.flush()))
  const elapsed = performance.now() - start
  const label =
    SESSIONS === 1
      ? 'real sink (batched, FULL)'
      : `real sink, ${SESSIONS} sessions (batched, FULL, shared writer)`
  report(label, RECORDS, elapsed)
}

async function runSinkMode() {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-journal-bench-sink-'))
  try {
    console.log(`sink bench: ${RECORDS} records, ${SESSIONS} session(s), node ${process.version}\n`)
    await benchRealSink(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// --- search mode ---------------------------------------------------------

const SEARCH_SESSION_COUNT = 20
const SEARCH_METHODS = ['tools/call', 'tools/list', 'resources/read']
const SEARCH_KINDS = ['request', 'response']
const SEARCH_DIRECTIONS = ['client→server', 'server→client']
const SEARCH_INSERT_BATCH = 10_000
const SEARCH_BASE_TIME_MS = Date.now()

/**
 * A schema-VALID journal record (unlike `makeRecord` above, which uses an
 * ASCII arrow that fails `isJournalRecord` — fine for the write-throughput
 * arms, wrong here: a malformed `doc` is skipped on read, and this mode
 * needs real matches to measure filtered-search latency, not the
 * malformed-skip path). Method/kind/direction cycle so a filter selects a
 * real subset instead of the whole table.
 */
function makeSearchRecord(i, sessionId) {
  const method = SEARCH_METHODS[i % SEARCH_METHODS.length]
  const kind = SEARCH_KINDS[i % SEARCH_KINDS.length]
  const direction = SEARCH_DIRECTIONS[i % SEARCH_DIRECTIONS.length]
  return {
    id: `01SEARCH${String(i).padStart(19, '0')}`,
    ts: new Date(SEARCH_BASE_TIME_MS + i).toISOString(),
    sessionId,
    direction,
    kind,
    method,
    rpcId: i,
    payload: {
      name: 'search_files',
      arguments: {
        path: '/home/user/projects/example-repository/src/components',
        pattern: '*.test.ts',
        recursive: true,
        note: 'search bench payload padding to reach a realistic record size xxxx',
      },
    },
  }
}

/** Generates `totalRows` rows directly via batched INSERTs (bypassing the sink — this arm measures reads). */
async function generateSearchRows(dir, totalRows) {
  const dbPath = journalDbPathFor(dir)
  const handle = await openJournalDbShared(dbPath)
  const start = performance.now()
  for (let offset = 0; offset < totalRows; offset += SEARCH_INSERT_BATCH) {
    const size = Math.min(SEARCH_INSERT_BATCH, totalRows - offset)
    const rows = []
    for (let i = offset; i < offset + size; i += 1) {
      const sessionId = `search-bench-${i % SEARCH_SESSION_COUNT}`
      const record = makeSearchRecord(i, sessionId)
      rows.push({
        sessionId,
        recordId: record.id,
        ts: record.ts,
        direction: record.direction,
        kind: record.kind,
        method: record.method,
        doc: JSON.stringify(record),
      })
    }
    handle.transaction((db) => insertRecordRows(db, rows))
  }
  const elapsed = performance.now() - start
  console.log(
    `row generation (direct insert, NOT query time)      ${Math.round(elapsed)} ms  (${totalRows} rows, ${Math.round((totalRows / elapsed) * 1000)} rows/s)`,
  )
  return handle
}

function percentile(sortedSamplesMs, p) {
  const idx = Math.min(sortedSamplesMs.length - 1, Math.ceil((p / 100) * sortedSamplesMs.length) - 1)
  return sortedSamplesMs[Math.max(0, idx)]
}

function reportLatency(label, samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const p50 = percentile(sorted, 50)
  const p95 = percentile(sorted, 95)
  console.log(`${label.padEnd(52)} p50 ${p50.toFixed(2)} ms  p95 ${p95.toFixed(2)} ms  (n=${samplesMs.length})`)
}

async function measureSearchSession(dir) {
  const samples = []
  for (let i = 0; i < 100; i += 1) {
    const start = performance.now()
    await searchSession('search-bench-0', { dir, method: SEARCH_METHODS[0], limit: 100 })
    samples.push(performance.now() - start)
  }
  return samples
}

async function measureSearchAllSessions(dir) {
  const samples = []
  for (let i = 0; i < 20; i += 1) {
    const start = performance.now()
    await searchAllSessions({ dir, method: SEARCH_METHODS[1] })
    samples.push(performance.now() - start)
  }
  return samples
}

async function runSearchMode() {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-journal-bench-search-'))
  try {
    console.log(`search bench: ${SEARCH_ROWS} rows across ${SEARCH_SESSION_COUNT} sessions, node ${process.version}\n`)
    const handle = await generateSearchRows(dir, SEARCH_ROWS)
    const sessionSamples = await measureSearchSession(dir)
    const crossSamples = await measureSearchAllSessions(dir)
    reportLatency('searchSession (1 session, method filter, limit 100)', sessionSamples)
    reportLatency('searchAllSessions (method filter, default limits)', crossSamples)
    handle.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// --- dispatch --------------------------------------------------------------

if (MODE === 'sink') {
  await runSinkMode()
} else if (MODE === 'search') {
  await runSearchMode()
} else {
  await runLegacyMode()
}
