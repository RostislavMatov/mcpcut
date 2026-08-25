#!/usr/bin/env node
// Controllable MCP stdio fixture for the M5.5 п.1 e2e suite
// (tests/e2e/m55-p1-status.test.ts).
//
// The probe must execute the CONFIRMED registry record byte for byte
// (ADR-0008), so a scenario can never vary this fixture's behavior through
// argv between probes. Instead argv[2] names a CONTROL FILE (JSON), read
// once per process start, and the test rewrites that file:
//
//   {
//     "mode":     "alive" | "dead" | "silent",   // default "alive"
//     "variant":  "v1" | "v2",                   // write_note inputSchema; v2 adds
//                                                //   one optional property (`force`)
//     "delayMs":  <number>,                      // per-answer delay, to hold a probe
//                                                //   open across a concurrency window
//     "spawnLog": <path>                         // append one line per process start
//   }
//
//  - "dead":   exit(1) immediately — the probe sees a child that ended
//              before answering (status "unreachable").
//  - "silent": read stdin forever, never answer — timeout territory.
//  - A missing or unreadable control file behaves as {mode:"alive", variant:"v1"}.
//
// Otherwise the dialect matches tests/fixtures/m4-server.mjs: newline-delimited
// JSON-RPC in, one line out per request, one stderr line at startup.

import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const control = readControl(process.argv[2])

if (typeof control.spawnLog === 'string') {
  appendFileSync(control.spawnLog, `spawn ${process.pid} ${Date.now()}\n`)
}

process.stderr.write(`probe-server: starting (${control.mode}/${control.variant})\n`)

if (control.mode === 'dead') {
  process.exit(1)
}

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

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line) => {
  if (control.mode === 'silent') return
  if (line.trim().length === 0) return
  const message = parseOrNull(line)
  if (message === null) return
  const response = buildResponse(message)
  if (response === null) return
  const write = () => process.stdout.write(`${JSON.stringify(response)}\n`)
  if (control.delayMs > 0) {
    setTimeout(write, control.delayMs)
  } else {
    write()
  }
})

rl.on('close', () => {
  process.exit(0)
})

function readControl(path) {
  const defaults = { mode: 'alive', variant: 'v1', delayMs: 0, spawnLog: undefined }
  if (typeof path !== 'string' || path.length === 0) return defaults
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return {
      mode: parsed.mode === 'dead' || parsed.mode === 'silent' ? parsed.mode : 'alive',
      variant: parsed.variant === 'v2' ? 'v2' : 'v1',
      delayMs: typeof parsed.delayMs === 'number' && parsed.delayMs > 0 ? parsed.delayMs : 0,
      spawnLog: typeof parsed.spawnLog === 'string' ? parsed.spawnLog : undefined,
    }
  } catch {
    return defaults
  }
}

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
      serverInfo: { name: 'probe-server', version: '0.0.1' },
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
          inputSchema: WRITE_SCHEMA[control.variant],
        },
      ],
    })
  }

  if (message.method === 'tools/call') {
    return ok(message.id, {
      content: [{ type: 'text', text: JSON.stringify({ served: control.variant }) }],
    })
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
