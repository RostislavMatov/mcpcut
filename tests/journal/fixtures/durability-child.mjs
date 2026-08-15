#!/usr/bin/env node
// Fixture for tests/journal/durability.test.ts: writes JournalRecord-shaped
// rows through the REAL sink (built dist, ADR-0006 batch writer), flushing
// every FLUSH_INTERVAL records. `confirmed:<count>` is only printed AFTER
// flush() resolves — printed means durable, per the wave 4 contract that
// flush() is the confirmation point a kill -9 must never invalidate.

import { createJournalSink } from '../../../dist/journal/sink.js'

const journalDir = process.argv[2]
if (!journalDir) {
  process.stderr.write('durability-child: missing journalDir arg\n')
  process.exit(1)
}

const FLUSH_INTERVAL = 25

const sink = createJournalSink('durability-child', { dir: journalDir })

async function run() {
  let seq = 0
  for (;;) {
    sink.write({
      id: `durability-${seq}`,
      ts: new Date().toISOString(),
      sessionId: 'durability-child',
      direction: 'client→server',
      kind: 'notification',
      payload: { seq },
    })
    seq += 1

    if (seq % FLUSH_INTERVAL === 0) {
      await sink.flush()
      process.stdout.write(`confirmed:${seq}\n`)
    }
  }
}

run().catch((error) => {
  process.stderr.write(`durability-child: ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})
