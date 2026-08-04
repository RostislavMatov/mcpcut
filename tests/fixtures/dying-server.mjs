#!/usr/bin/env node
// Fake MCP stdio server that dies hard (SIGKILL) in the middle of answering a
// request, leaving an unterminated line behind.
//
// Used to check that a child crashing mid-request while the client's stdin is
// still open results in a clean, mapped shutdown rather than a hung or
// crashed proxy.

import { createInterface } from 'node:readline'

process.stderr.write('dying-server: starting\n')

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on('line', () => {
  // Deliberately unterminated: the response is cut off mid-message.
  process.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"partial":')
  process.kill(process.pid, 'SIGKILL')
})
