#!/usr/bin/env node
// Fake MCP stdio server that speaks ONLY the 2026-07-28 revision, the way the
// TS SDK v2 builds one with `serveStdio(factory, { legacy: 'reject' })`
// (ADR-0015 amendment 2026-09-23, RV1-RV5). Tool names come from argv:
//
//   node pool-modern-server.mjs echo needs_input   → tools `echo`, `needs_input`
//
//   - `initialize` → -32022 with data {supported: ['2026-07-28'], requested};
//   - any request without the three `_meta` keys → -32602;
//   - `server/discover` → supportedVersions ['2026-07-28'], tools + prompts;
//   - `tools/list` → the argv tools, with `resultType`/`ttlMs`/`cacheScope`;
//   - `prompts/list` → no prompts;
//   - `tools/call` → echo of `params`, the `_meta` it received included;
//     the tool `needs_input` answers {resultType: 'input_required',
//     requestState: 'r1'} instead — a load-shedding answer to a client that
//     declared no capabilities;
//   - `ping` (removed by the revision) and anything unknown → -32601.
//
// `POOL_MODERN_DUAL=1` turns it into a DUAL-mode server: it also answers
// `initialize` with 2025-11-25, as every public server that supports the new
// revision does today — and, as the spec allows, a handshake selects the OLD
// semantics for the life of the process: `_meta` is no longer required.

import { createInterface } from 'node:readline'

const TOOL_NAMES = process.argv.slice(2)
const NAME = process.env.POOL_FIXTURE_NAME ?? 'pool-modern-server'
const IS_DUAL = process.env.POOL_MODERN_DUAL === '1'
let isLegacy = false
const META_KEYS = [
  'io.modelcontextprotocol/protocolVersion',
  'io.modelcontextprotocol/clientCapabilities',
  'io.modelcontextprotocol/clientInfo',
]

process.stderr.write(`${NAME}: starting (2026-07-28${IS_DUAL ? ', dual' : ''})\n`)

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('close', () => process.exit(0))
rl.on('line', (line) => {
  if (line.trim().length === 0) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id === undefined) return
  process.stdout.write(`${JSON.stringify(answer(message))}\n`)
})

function error(id, code, text, data) {
  return { jsonrpc: '2.0', id, error: { code, message: text, ...(data ? { data } : {}) } }
}

function result(id, body) {
  return { jsonrpc: '2.0', id, result: { ...body, resultType: body.resultType ?? 'complete' } }
}

function answer(message) {
  const { id, method } = message
  if (method === 'initialize') {
    if (IS_DUAL) {
      isLegacy = true
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: NAME, version: '0.0.1' },
        },
      }
    }
    return error(id, -32022, 'Unsupported protocol version', {
      supported: ['2026-07-28'],
      requested: message.params?.protocolVersion ?? null,
    })
  }
  const meta = message.params?._meta ?? {}
  if (!isLegacy && !META_KEYS.every((key) => key in meta)) {
    return error(id, -32602, 'Missing required _meta')
  }
  if (method === 'server/discover') {
    return result(id, {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {}, prompts: {} },
      ttlMs: 0,
      cacheScope: 'public',
    })
  }
  if (method === 'tools/list') {
    const tools = TOOL_NAMES.map((name) => ({ name, description: `${NAME} ${name}`, inputSchema: { type: 'object' } }))
    return result(id, { tools, ttlMs: 0, cacheScope: 'public' })
  }
  if (method === 'prompts/list') {
    return result(id, { prompts: [], ttlMs: 0, cacheScope: 'public' })
  }
  if (method === 'tools/call') {
    if (message.params?.name === 'needs_input') {
      return { jsonrpc: '2.0', id, result: { resultType: 'input_required', requestState: 'r1' } }
    }
    const text = JSON.stringify({ server: NAME, params: message.params ?? {} })
    return result(id, { content: [{ type: 'text', text }] })
  }
  return error(id, -32601, `Method not found: ${String(method)}`)
}
