#!/usr/bin/env node
// Fake MCP stdio server that answers one request with a burst of responses and
// then exits immediately, without waiting for the client to read them.
//
// This reproduces the "exit before drain" case: at the moment the child's
// 'exit' event fires, most of the burst is still sitting in the OS pipe.
// It also exits on its own while the client's stdin stays open, which is the
// shape needed to catch a zombie proxy.

import { createInterface } from 'node:readline'

const DEFAULT_RESPONSE_COUNT = 40
const DEFAULT_PADDING_CHARS = 0

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line) => {
  const message = parseOrNull(line)
  if (message === null) {
    return
  }

  const count = Number(message.params?.count ?? DEFAULT_RESPONSE_COUNT)
  // Padding makes the burst larger than the OS pipe buffer, so a slow reader
  // cannot possibly have drained it all by the time this process exits.
  const padding = 'p'.repeat(Number(message.params?.padding ?? DEFAULT_PADDING_CHARS))
  const burst = Array.from(
    { length: count },
    (_unused, index) => `${JSON.stringify({ jsonrpc: '2.0', id: index, result: { index, padding } })}\n`,
  ).join('')

  // Exit only once the burst has reached the OS pipe: writes to a pipe are
  // asynchronous on macOS, so a bare process.exit() would truncate them.
  process.stdout.write(burst, () => process.exit(0))
})

function parseOrNull(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}
