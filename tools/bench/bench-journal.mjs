#!/usr/bin/env node
// Reproducible journal-write benchmark behind ADR-0006 (Evidence table).
// Compares, over the REAL modules from dist/:
//
//   1. current JSONL sink (`createJournalSink`, appendFile, no fsync)
//   2. SQLite WAL, batched transactions   (synchronous=NORMAL)
//   3. SQLite WAL, batched transactions   (synchronous=FULL)
//   4. same as 3 + sha256 hash chain per record (the M5 load)
//
// Usage:
//   npm run build
//   node tools/bench/bench-journal.mjs [--records 20000] [--sessions 1] [--batch 256]
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
import { openSqlite } from '../../dist/store/sqlite.js'

const { values: args } = parseArgs({
  options: {
    records: { type: 'string', default: '20000' },
    sessions: { type: 'string', default: '1' },
    batch: { type: 'string', default: '256' },
  },
})
const RECORDS = Number(args.records)
const SESSIONS = Number(args.sessions)
const BATCH = Number(args.batch)

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
  report(`JSONL sink, ${SESSIONS} session(s)`, RECORDS, elapsed)
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
