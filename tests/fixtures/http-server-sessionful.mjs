#!/usr/bin/env node
// Fake sessionful streamable-HTTP MCP server (spec 2025-06-18 with
// 2025-11-25 deltas) for transport client tests. Plain executable .mjs so
// no TS loader is required to spawn it; prints its ephemeral port as the
// first stdout line.
//
// MCP endpoint: /mcp
//   POST initialize        -> 200 JSON InitializeResult + Mcp-Session-Id header
//   POST request           -> 200 JSON echo {echo: method, sessionId: <seen header>}
//   POST notification      -> 202 empty
//   POST without known sid -> 400 (missing) / 404 (unknown or expired)
//   GET                    -> SSE stream bound to the session (or 405/500, see env)
//   DELETE                 -> ends the session (or 405, see env)
//
// Test control endpoints (NOT part of MCP):
//   POST /__control/emit[?retry=<ms>]  body -> one SSE event on every open GET
//                                      stream; each body line becomes its own
//                                      `data:` line (multi-line data testing)
//   POST /__control/expire             forget all sessions (next sid -> 404)
//   POST /__control/drop-get           hard-destroy open GET streams
//   GET  /__control/stats              JSON state dump for assertions
//
// Env knobs:
//   NO_SESSION=1         never issue a session id (old spec: server MAY not)
//   GET_UNSUPPORTED=1    respond 405 to GET (no server-initiated stream)
//   GET_FAIL=always      respond 500 to every GET (reconnect-exhaustion tests)
//   DELETE_UNSUPPORTED=1 respond 405 to DELETE

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const sessions = new Set()
const getStreams = new Set()
const stats = { posts: 0, getRequests: 0, deletes: 0, lastPostHeaders: null }

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function json(res, status, value, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify(value))
}

function handleControl(url, req, res, body) {
  if (url.pathname === '/__control/emit' && req.method === 'POST') {
    const retry = url.searchParams.get('retry')
    for (const stream of getStreams) {
      if (retry !== null) {
        stream.write(`retry: ${retry}\n`)
      }
      for (const line of body.toString('utf8').split('\n')) {
        stream.write(`data: ${line}\n`)
      }
      stream.write('\n')
    }
    return json(res, 200, { streams: getStreams.size })
  }
  if (url.pathname === '/__control/expire' && req.method === 'POST') {
    sessions.clear()
    return json(res, 200, { ok: true })
  }
  if (url.pathname === '/__control/drop-get' && req.method === 'POST') {
    for (const stream of getStreams) {
      stream.destroy()
    }
    getStreams.clear()
    return json(res, 200, { ok: true })
  }
  if (url.pathname === '/__control/stats' && req.method === 'GET') {
    return json(res, 200, {
      ...stats,
      sessions: [...sessions],
      openGetStreams: getStreams.size,
    })
  }
  res.writeHead(404)
  res.end()
}

function handlePost(req, res, body) {
  stats.posts += 1
  stats.lastPostHeaders = { ...req.headers }
  let message
  try {
    message = JSON.parse(body.toString('utf8'))
  } catch {
    res.writeHead(400)
    return res.end()
  }

  if (message.method === 'initialize') {
    const headers = {}
    if (process.env.NO_SESSION !== '1') {
      const sid = randomUUID()
      sessions.add(sid)
      headers['Mcp-Session-Id'] = sid
    }
    return json(
      res,
      200,
      {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          serverInfo: { name: 'fixture-sessionful', version: '0.0.1' },
        },
      },
      headers,
    )
  }

  const sid = req.headers['mcp-session-id']
  if (process.env.NO_SESSION !== '1') {
    if (typeof sid !== 'string') {
      res.writeHead(400)
      return res.end()
    }
    if (!sessions.has(sid)) {
      res.writeHead(404)
      return res.end()
    }
  }

  if (message.id === undefined) {
    res.writeHead(202)
    return res.end()
  }
  return json(res, 200, {
    jsonrpc: '2.0',
    id: message.id,
    result: { echo: message.method, sessionId: typeof sid === 'string' ? sid : null },
  })
}

function handleGet(req, res) {
  stats.getRequests += 1
  if (process.env.GET_UNSUPPORTED === '1') {
    res.writeHead(405)
    return res.end()
  }
  if (process.env.GET_FAIL === 'always') {
    res.writeHead(500)
    return res.end()
  }
  const sid = req.headers['mcp-session-id']
  if (typeof sid !== 'string' || !sessions.has(sid)) {
    res.writeHead(404)
    return res.end()
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  res.write(': stream open\n\n')
  getStreams.add(res)
  req.on('close', () => getStreams.delete(res))
}

function handleDelete(req, res) {
  stats.deletes += 1
  if (process.env.DELETE_UNSUPPORTED === '1') {
    res.writeHead(405)
    return res.end()
  }
  const sid = req.headers['mcp-session-id']
  if (typeof sid === 'string') {
    sessions.delete(sid)
  }
  res.writeHead(204)
  res.end()
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const body = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0)
  if (url.pathname.startsWith('/__control/')) {
    return handleControl(url, req, res, body)
  }
  if (req.method === 'POST') {
    return handlePost(req, res, body)
  }
  if (req.method === 'GET') {
    return handleGet(req, res)
  }
  if (req.method === 'DELETE') {
    return handleDelete(req, res)
  }
  res.writeHead(405)
  res.end()
})

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`)
})
