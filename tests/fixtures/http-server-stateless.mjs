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
