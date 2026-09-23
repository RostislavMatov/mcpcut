#!/usr/bin/env node
// Fake stateless streamable-HTTP MCP server (spec 2026-07-28) for transport
// client tests. Plain executable .mjs; prints its ephemeral port as the
// first stdout line.
//
// MCP endpoint: /mcp — POST only (new model: no sessions, no GET, no DELETE):
//   POST request       -> 200 JSON echo {echo: method, receivedHeaders: {...}}
//   POST notification  -> 202 empty
//   Mcp-Method header, when present, is validated against the body's
//   `method`; mismatch -> 400 + JSON-RPC error -32020 (HeaderMismatch)
//   GET / DELETE       -> 405
//
// Test control endpoints (NOT part of MCP):
//   GET /__control/stats  JSON state dump for assertions
//
// Env knobs:
//   SSE_RESPONSE=1  answer requests as an SSE stream (a related notification
//                   event first, then the response event) instead of JSON
//   BOOM=1          answer every MCP POST with 500 (typed-error tests)
//   STRICT=1        behave like a server that speaks ONLY 2026-07-28, the way
//                   the TS SDK v2 builds one with `legacy: 'reject'`:
//                     - every request MUST carry the three `_meta` keys, else
//                       400 + -32602; `MCP-Protocol-Version` MUST equal the
//                       body's `_meta` version, else 400 + -32020;
//                     - `initialize` -> 400 + -32022 {supported, requested};
//                     - `tools/list` -> the tools named by STRICT_TOOLS
//                       (comma-separated, default `echo`);
//                     - `tools/call` -> echo of params and received headers;
//                       an unknown tool -> 400 + -32602;
//                     - `prompts/list` and any unknown method -> 404 + -32601
//                       (a member with no prompts, answering as the spec says).
//
// `server/discover` is answered in every mode, with 2026-07-28 as the only
// supported version.

import { createServer } from 'node:http'

const stats = { posts: 0, lastPostHeaders: null }

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

function pickReceivedHeaders(req) {
  return {
    'mcp-protocol-version': req.headers['mcp-protocol-version'] ?? null,
    'mcp-method': req.headers['mcp-method'] ?? null,
    'mcp-name': req.headers['mcp-name'] ?? null,
    'mcp-session-id': req.headers['mcp-session-id'] ?? null,
  }
}

function handlePost(req, res, body) {
  stats.posts += 1
  stats.lastPostHeaders = { ...req.headers }

  if (process.env.BOOM === '1') {
    res.writeHead(500)
    return res.end()
  }

  let message
  try {
    message = JSON.parse(body.toString('utf8'))
  } catch {
    res.writeHead(400)
    return res.end()
  }

  if (message.method === 'server/discover' && message.id !== undefined) {
    return json(res, 200, {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'public',
      },
    })
  }

  if (process.env.STRICT === '1') {
    const refusal = strictRefusal(req, message)
    if (refusal !== null) return json(res, refusal.status, refusal.body)
    const answer = strictAnswer(req, message)
    if (answer !== null) return json(res, answer.status, answer.body)
  }

  const mcpMethod = req.headers['mcp-method']
  if (typeof mcpMethod === 'string' && mcpMethod !== message.method) {
    return json(res, 400, {
      jsonrpc: '2.0',
      id: message.id ?? null,
      error: { code: -32020, message: 'HeaderMismatch: Mcp-Method does not match body method' },
    })
  }

  if (message.id === undefined) {
    res.writeHead(202)
    return res.end()
  }

  const response = {
    jsonrpc: '2.0',
    id: message.id,
    result: { echo: message.method, receivedHeaders: pickReceivedHeaders(req) },
  }

  if (process.env.SSE_RESPONSE === '1') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' })
    const note = { jsonrpc: '2.0', method: 'notifications/message', params: { note: 'pre-response' } }
    res.write(`data: ${JSON.stringify(note)}\n\n`)
    res.write(`data: ${JSON.stringify(response)}\n\n`)
    return res.end()
  }
  return json(res, 200, response)
}

const META_VERSION = 'io.modelcontextprotocol/protocolVersion'
const META_KEYS = [
  META_VERSION,
  'io.modelcontextprotocol/clientCapabilities',
  'io.modelcontextprotocol/clientInfo',
]

function rpcError(status, id, code, message, data) {
  return {
    status,
    body: { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } },
  }
}

/** STRICT: what a 2026-07-28-only server refuses before looking at the method. */
function strictRefusal(req, message) {
  if (message.method === 'initialize') {
    return rpcError(400, message.id, -32022, 'Unsupported protocol version', {
      supported: ['2026-07-28'],
      requested: message.params?.protocolVersion ?? null,
    })
  }
  if (message.id === undefined) return null
  const meta = message.params?._meta ?? {}
  if (!META_KEYS.every((key) => key in meta)) {
    return rpcError(400, message.id, -32602, 'Missing required _meta')
  }
  if (req.headers['mcp-protocol-version'] !== meta[META_VERSION]) {
    return rpcError(400, message.id, -32020, 'HeaderMismatch: MCP-Protocol-Version')
  }
  return null
}

/** STRICT: answers to the methods such a server serves; `null` = not a request. */
function strictAnswer(req, message) {
  if (message.id === undefined) return null
  if (message.method === 'tools/list') {
    const names = (process.env.STRICT_TOOLS ?? 'echo').split(',')
    const tools = names.map((name) => ({ name, description: `strict ${name}`, inputSchema: { type: 'object' } }))
    return { status: 200, body: { jsonrpc: '2.0', id: message.id, result: { tools, resultType: 'complete' } } }
  }
  if (message.method === 'tools/call') {
    const known = (process.env.STRICT_TOOLS ?? 'echo').split(',')
    if (!known.includes(message.params?.name)) {
      return rpcError(400, message.id, -32602, 'Unknown tool')
    }
    const text = JSON.stringify({ params: message.params ?? {}, receivedHeaders: pickReceivedHeaders(req) })
    return {
      status: 200,
      body: { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }], resultType: 'complete' } },
    }
  }
  return rpcError(404, message.id, -32601, `Method not found: ${String(message.method)}`)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/__control/stats' && req.method === 'GET') {
    return json(res, 200, { ...stats })
  }
  if (req.method === 'POST') {
    return handlePost(req, res, await readBody(req))
  }
  res.writeHead(405)
  res.end()
})

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`)
})
