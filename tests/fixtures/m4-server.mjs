#!/usr/bin/env node
// Fake MCP stdio server for the M4 end-to-end suite
// (tests/e2e/m4-integration.test.ts).
//
// Two things set it apart from tests/fixtures/policy-server.mjs (which the M2/M3
// suites depend on and this task must not touch):
//
//  1. Its `write_note` tool carries a real `inputSchema`, and a SCHEMA VARIANT is
//     selected by argv[2] (`v1` | `v2`). `v2` adds one optional property, which is
//     exactly the "widened surface" a quarantine card must render as a structural
//     diff rather than "hashes diverged". The registry entry's `--args` chooses the
//     variant, so a test can re-register the same server name against a changed
//     server without touching any store directly.
//  2. It answers `resources/list` and `resources/read`, so the resources grant
//     dimension (M4 Task 6) can be exercised end to end instead of stopping at a
//     `-32601` from a server that never had resources.
//
// Otherwise it behaves like the other stdio fixtures: newline-delimited JSON-RPC
// in, one line of JSON-RPC out per request, one stderr line at startup.

import { createInterface } from 'node:readline'

const VARIANT = process.argv[2] === 'v2' ? 'v2' : 'v1'

process.stderr.write(`m4-server: starting (${VARIANT})\n`)

const WRITE_SCHEMA = {
  v1: {
    type: 'object',
    properties: { path: { type: 'string' }, text: { type: 'string' } },
    required: ['path'],
  },
  v2: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      text: { type: 'string' },
      // The one difference: a fresh optional property → surfaceDelta "widened".
      force: { type: 'boolean' },
    },
    required: ['path'],
  },
}

const RESOURCES = [
  { uri: 'file:///project/readme.md', name: 'readme', mimeType: 'text/markdown' },
  { uri: 'file:///secrets/keys.env', name: 'keys', mimeType: 'text/plain' },
]

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line) => {
  if (line.trim().length === 0) return
  const message = parseOrNull(line)
  if (message === null) return
  const response = buildResponse(message)
  if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`)
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
  if (message.id === undefined) return null

  if (message.method === 'initialize') {
    return ok(message.id, {
      protocolVersion: '2026-07-28',
      capabilities: {},
      serverInfo: { name: 'm4-server', version: '0.0.1' },
    })
  }

  if (message.method === 'tools/list') {
    return ok(message.id, {
      tools: [
        {
          name: 'read_note',
          description: 'Reads a note',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'write_note',
          description: 'Writes a note',
          inputSchema: WRITE_SCHEMA[VARIANT],
        },
      ],
    })
  }

  if (message.method === 'tools/call') {
    return ok(message.id, {
      content: [{ type: 'text', text: JSON.stringify({ served: VARIANT, params: message.params ?? {} }) }],
    })
  }

  if (message.method === 'resources/list') {
    return ok(message.id, { resources: RESOURCES })
  }

  if (message.method === 'resources/read') {
    const uri = message.params?.uri ?? ''
    return ok(message.id, { contents: [{ uri, mimeType: 'text/plain', text: `contents of ${uri}` }] })
  }

  return {
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: `Method not found: ${String(message.method)}` },
  }
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result }
}
