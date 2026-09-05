#!/usr/bin/env node
// Stand-in for `mcp-journal ui` / `mcp-journal serve` in the service-manager
// tests (mcpcut phase 1, Task 10). The manager spawns whatever `cliPath` it
// is given as `node <cliPath> <service> --host H --port P [...]`, and the
// tests cannot point it at `dist/cli.js` (the suite runs from source), so
// this file speaks the same argv and shows the same daemon manners.
//
// Argv: <ui|serve> --host H --port P   (any further flag is accepted and
//       ignored, the way extra `--allowed-host` flags reach the real ones)
//
// Behaviour per service, matching what each probe looks for:
//   ui     GET /login -> 200, anything else -> 404
//   serve  every request -> 401 (the real front refuses unauthenticated
//          traffic; its probe only checks that the port accepts a connection)
//
// Daemon manners: stdout stays empty, diagnostics go to stderr, and the
// listening line is `<service>: listening on http://H:P` — the same shape
// `ui-cmd.ts` and `serve-cmd.ts` print, so a log tail reads the same.
//
// SIGTERM -> close the server and exit 0.
//
// Env knobs:
//   FAKE_IGNORE_SIGTERM=1   install a no-op SIGTERM handler, so a stop has to
//                           escalate to SIGKILL
//   FAKE_EXIT_CODE=3        write one stderr line and exit with that code
//                           immediately (the "start failed" path; the line
//                           gives the log tail something to show)
//   FAKE_BIND_BUSY=1        print an EADDRINUSE-shaped bind failure and exit 1
//                           without listening
//   FAKE_SLOW_START_MS=250  wait this long before listening (readiness timeout)

import { createServer } from 'node:http'

const [, , service, ...rest] = process.argv

function flagValue(name) {
  const index = rest.indexOf(`--${name}`)
  return index >= 0 ? rest[index + 1] : undefined
}

const host = flagValue('host') ?? '127.0.0.1'
const port = Number(flagValue('port') ?? 0)

if (service !== 'ui' && service !== 'serve') {
  process.stderr.write(`fake-service: unknown service "${service}"\n`)
  process.exit(2)
}

// Die before doing anything else: the manager must report `failed` and show
// this line in the log tail.
if (process.env.FAKE_EXIT_CODE !== undefined) {
  const code = Number(process.env.FAKE_EXIT_CODE)
  process.stderr.write(`${service}: refusing to start (FAKE_EXIT_CODE=${code})\n`)
  process.exit(code)
}

// Same text `cli/bind-failure.ts` produces, so a test asserting on the log
// tail sees what a real occupied port would leave there.
if (process.env.FAKE_BIND_BUSY === '1') {
  process.stderr.write(`${service}: cannot bind ${host}:${port}: address already in use\n`)
  process.exit(1)
}

const server = createServer((req, res) => {
  if (service === 'serve') {
    res.writeHead(401)
    return res.end()
  }
  res.writeHead(req.method === 'GET' && req.url === '/login' ? 200 : 404)
  res.end()
})

server.on('error', (error) => {
  process.stderr.write(`${service}: cannot bind ${host}:${port}: ${error.message}\n`)
  process.exit(1)
})

function shutdown() {
  server.close(() => process.exit(0))
}

process.on('SIGTERM', () => {
  if (process.env.FAKE_IGNORE_SIGTERM === '1') {
    process.stderr.write(`${service}: ignoring SIGTERM\n`)
    return
  }
  process.stderr.write(`${service}: SIGTERM received, shutting down\n`)
  shutdown()
})

function listen() {
  server.listen(port, host, () => {
    const bound = server.address()
    process.stderr.write(`${service}: listening on http://${host}:${bound.port}\n`)
  })
}

const slowStartMs = Number(process.env.FAKE_SLOW_START_MS ?? 0)
if (slowStartMs > 0) {
  setTimeout(listen, slowStartMs)
} else {
  listen()
}
