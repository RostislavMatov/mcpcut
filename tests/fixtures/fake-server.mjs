#!/usr/bin/env node
// Minimal fake MCP stdio server for integration tests.
//
// Reads newline-delimited JSON-RPC from stdin, responds to `initialize`
// and `tools/list` with canned responses, echoes a response for
// `tools/call`, and writes one diagnostic line to stderr on startup.
// Plain executable .mjs so no TS loader is required to spawn it.

import { createInterface } from 'node:readline'

process.stderr.write('fake-server: starting\n')

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line) => {
  if (line.trim().length === 0) {
    return
  }

  const message = parseOrNull(line)
  if (message === null) {
    return
  }

  const response = buildResponse(message)
  if (response !== null) {
    process.stdout.write(`${JSON.stringify(response)}\n`)
  }
})

rl.on('close', () => {
  process.exit(0)
})

function parseOrNull(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function buildResponse(message) {
  if (message.id === undefined) {
    return null
  }

  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2026-07-28',
        capabilities: {},
        serverInfo: { name: 'fake-server', version: '0.0.1' },
      },
    }
  }

  if (message.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{ name: 'echo', description: 'Echoes input', inputSchema: { type: 'object' } }],
      },
    }
  }

  if (message.method === 'tools/call') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(message.params ?? {}) }],
      },
    }
  }

  return {
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: `Method not found: ${String(message.method)}` },
  }
}
