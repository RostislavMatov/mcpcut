#!/usr/bin/env node
// Fake MCP stdio server for the teardown grace of decision M36, phase C
// (tests/proxy/wrap-grace.test.ts): `tools/call` answers after
// `arguments.delayMs`, or never when it is negative. Exits when its stdin
// ends, as most stdio servers do — dropping whatever it had not answered.

import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id === undefined) return
  if (message.method === 'initialize') {
    reply({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'slow-answer', version: '0.0.1' } } })
    return
  }
  if (message.method === 'tools/call') {
    const delayMs = Number(message.params?.arguments?.delayMs ?? 0)
    if (delayMs < 0) return
    setTimeout(() => reply({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `answered after ${delayMs} ms` }] } }), delayMs)
    return
  }
  reply({ jsonrpc: '2.0', id: message.id, result: {} })
})

rl.on('close', () => process.exit(0))

function reply(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
