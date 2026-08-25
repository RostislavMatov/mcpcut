#!/usr/bin/env node
// Fake stdio MCP server that never answers anything — used to prove the
// probe times out AND cleans its child up. Writes its pid to the file given
// as argv[2] so the test can verify the process is gone afterwards, and
// deliberately survives its stdin closing (so only the SIGTERM escalation
// path can end it). Plain executable .mjs, same style as fake-server.mjs.

import { writeFileSync } from 'node:fs'

const pidFile = process.argv[2]
if (pidFile !== undefined) {
  writeFileSync(pidFile, String(process.pid))
}

process.stdin.resume()
// Outlive the polite stdin-close exit request: only signals end this server.
setInterval(() => undefined, 60_000)
