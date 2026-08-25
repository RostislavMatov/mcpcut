#!/usr/bin/env node
// Fake stdio MCP server that answers every request line with bytes that are
// not JSON-RPC at all — used to prove the probe classifies a talking-but-
// broken server as `error`, not `unreachable`. Plain executable .mjs, same
// style as fake-server.mjs.

import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line) => {
  if (line.trim().length === 0) {
    return
  }
  process.stdout.write('this is not JSON-RPC at all\n')
})

rl.on('close', () => {
  process.exit(0)
})
