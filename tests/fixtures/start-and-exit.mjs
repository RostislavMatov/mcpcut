#!/usr/bin/env node
// A parent that starts a service and dies (mcpcut phase 1, Task 11) — the
// only way to prove the detach for real: no assertion inside the manager can
// show that a child survives the process that spawned it.
//
// It spawns with exactly the options `detachedSpawnOptions` produces
// (`detached: true`, stdio to a log file descriptor, `unref()`), prints the
// child's pid on stdout and exits at once. The test then waits for THIS
// process to be gone before probing the service.
//
// Argv: <cliPath> <logPath> <ui|serve> <host> <port>

import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'

const [, , cliPath, logPath, service, host, port] = process.argv

const logFd = openSync(logPath, 'a', 0o600)
const child = spawn(process.execPath, [cliPath, service, '--host', host, '--port', port], {
  detached: true,
  stdio: ['ignore', logFd, logFd],
  env: process.env,
  cwd: process.cwd(),
})
closeSync(logFd)
child.unref()

// Exit only once the pid has actually reached the pipe: a bare `process.exit`
// can truncate a pending write and leave the test with no pid to check.
process.stdout.write(`${child.pid}\n`, () => process.exit(0))
