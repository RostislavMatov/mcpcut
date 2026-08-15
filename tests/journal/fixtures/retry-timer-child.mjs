#!/usr/bin/env node
// Fixture for tests/journal/retry-timer.test.ts: one record whose first commit
// attempt fails, so the batch writer's retry delay becomes the ONLY pending
// work in the process. Nothing else is scheduled and `flushNow()` is not
// awaited — exactly the shape a `connect`/`wrap` process has at shutdown.
//
// `enqueued` is printed synchronously, `settled:*` only from the settlement
// callback. If the retry delay ever goes back to an unref'd timer, Node exits
// 0 between the two lines and the record dies silently: that missing second
// line is what the test looks for.

import { getBatchWriter } from '../../../dist/journal/batch-writer.js'

const dbPath = process.argv[2]
if (!dbPath) {
  process.stderr.write('retry-timer-child: missing dbPath arg\n')
  process.exit(1)
}

// Long enough that an unref'd timer loses the race by orders of magnitude
// (a pipe write completes in well under a millisecond), short enough to keep
// the test quick.
const RETRY_DELAY_MS = 200

let attempts = 0
// Injected, so no database is ever opened: an open handle would keep the
// event loop alive on its own and hide the very defect under test.
const commitBatchImpl = async () => {
  attempts += 1
  if (attempts === 1) {
    throw new Error('injected first-attempt failure')
  }
}

const writer = getBatchWriter(dbPath, {
  maxRecords: 256,
  maxDelayMs: 60_000,
  retryDelayMs: RETRY_DELAY_MS,
  commitBatchImpl,
})

writer.enqueue(
  {
    sessionId: 'retry-timer-child',
    recordId: 'retry-timer-1',
    ts: new Date().toISOString(),
    direction: 'client→server',
    kind: 'notification',
    method: 'tools/call',
    doc: JSON.stringify({ id: 'retry-timer-1' }),
  },
  (result) => {
    process.stdout.write(result.ok ? 'settled:ok\n' : 'settled:dropped\n')
  },
)

process.stdout.write('enqueued\n')
void writer.flushNow()
