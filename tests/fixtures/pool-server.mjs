#!/usr/bin/env node
// Fake MCP stdio server for the agent-pool tests (ADR-0015 phase 3).
//
// Why a new fixture rather than reusing policy-server.mjs: every stdio fixture
// in this repo answers `initialize` with protocolVersion '2026-07-28', the
// revision that REMOVED the handshake. A pool opens a handshake of its own to
// each upstream (the plane answered the agent's own — PE12), and
// `readUpstreamInitializeResult` refuses a revision it cannot negotiate, so
// those fixtures are correctly seen as servers that did not come up. This one
// answers a sessionful revision, like a server a pool can actually hold.
//
// Its tool names come from argv, so one file can stand in for several
// registered servers:
//
//   node pool-server.mjs echo risky     → tools `echo` and `risky`
//
// `tools/call` echoes its params back, as the other fixtures do.

import { createInterface } from 'node:readline'

const TOOL_NAMES = process.argv.slice(2)
const NAME = process.env.POOL_FIXTURE_NAME ?? 'pool-server'

process.stderr.write(`${NAME}: starting\n`)

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line) => {
  if (line.trim().length === 0) return
  const message = parseOrNull(line)
  if (message === null) return
  const response = buildResponse(message)
  if (response !== null) {
    process.stdout.write(`${JSON.stringify(response)}\n`)
  }
})

rl.on('close', () => process.exit(0))

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
        // A revision the plane can negotiate, so the pool's handshake succeeds.
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: true }, prompts: {} },
        serverInfo: { name: NAME, version: '0.0.1' },
      },
    }
  }

  if (message.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: TOOL_NAMES.map((name) => ({
          name,
          description: `${NAME} tool ${name}`,
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
        })),
      },
    }
  }

  if (message.method === 'prompts/list') {
    return { jsonrpc: '2.0', id: message.id, result: { prompts: [] } }
  }

  if (message.method === 'tools/call') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [
          { type: 'text', text: JSON.stringify({ server: NAME, params: message.params ?? {} }) },
        ],
      },
    }
  }

  return {
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: `Method not found: ${String(message.method)}` },
  }
}
