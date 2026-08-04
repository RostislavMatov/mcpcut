#!/usr/bin/env node
// Fake MCP stdio server used by the policy integration tests
// (tests/proxy/policy-integration.test.ts) for scenarios that need more than
// one tool in the catalog: `tools/list` filtering (a denied tool must
// disappear, an untouched one must keep an unknown vendor field), and the
// quarantine side effect of observing a fresh catalog.
//
// Kept as a separate fixture rather than editing tests/fixtures/fake-server.mjs
// (the M1 fixture, shared by tests this task must not touch) per this task's
// ownership boundary.
//
// Behaves like fake-server.mjs otherwise: newline-delimited JSON-RPC in,
// canned `initialize` response, `tools/call` echoes its params back, one
// stderr line on startup.

import { createInterface } from 'node:readline'

process.stderr.write('policy-server: starting\n')

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
        serverInfo: { name: 'policy-server', version: '0.0.1' },
      },
    }
  }

  if (message.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echoes input',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'risky_tool',
            description: 'Does something that needs an explicit rule',
            inputSchema: { type: 'object' },
          },
          {
            name: 'special_tool',
            description: 'A tool a vendor extended with a field this proxy does not know',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true },
            'x-acme-tier': 'gold',
          },
        ],
        nextCursor: 'page-2',
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
