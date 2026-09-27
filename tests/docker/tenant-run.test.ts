import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

/**
 * `docker/tenant-run.sh` (tenant-orchestrator plan, Task 2): one container
 * runs both `ui` and `serve`, instead of the two-container layout in
 * `docker-compose.yml`. First start still goes through `docker/first-start.sh`
 * (shared with `docker/entrypoint.sh`, covered by `tests/docker/
 * entrypoint.test.ts`) — these tests are about the part unique to this
 * script: starting both, and reacting to whichever exits, or is signalled,
 * first.
 *
 * Both processes are long-running, so these tests use `spawn` (not
 * `spawnSync`, like the entrypoint tests) and interact with the running
 * script over time: sending it signals, or letting a fake child "exit" on
 * its own. A fake `node` earlier on `PATH` stands in for the real CLI, the
 * same trick `entrypoint.test.ts` uses, extended with an env-controlled
 * BEHAVIOR so a test can make the `ui` or `serve` invocation exit
 * immediately with a chosen code, or block until it receives TERM and THEN
 * exit with a chosen code (simulating a graceful shutdown).
 *
 * One thing this file's fake `node` deliberately does NOT do: answer
 * `kill -0` truthfully for a "zombie" state. That distinction is exercised
 * indirectly — `docker/tenant-run.sh`'s own retry-loop around `wait` (see its
 * header comment) is what makes the exit codes asserted below come out
 * right despite `wait` returning early when a trapped signal arrives; a bug
 * in that loop would surface here as a wrong code, not a hang, because the
 * fake children below always genuinely terminate.
 */

const TENANT_RUN = join(process.cwd(), 'docker', 'tenant-run.sh')
const FAKE_NODE_MODE = 0o755
const TEST_TIMEOUT_MS = 8_000
const SAFETY_KILL_MS = 6_000

let workDir: string
let binDir: string

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mcpcut-tenant-run-'))
  binDir = join(workDir, 'bin')
  await writeFakeNode()
})

const spawned: ChildProcessWithoutNullStreams[] = []

afterEach(async () => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  await rm(workDir, { recursive: true, force: true })
})

/**
 * Stands in for `node` inside the image. Every invocation logs its argv, the
 * same as `entrypoint.test.ts`'s fake `node`, and answers a `setup` call by
 * writing the config file. For `ui`/`serve` it additionally reads
 * `FAKE_UI_BEHAVIOR`/`FAKE_SERVE_BEHAVIOR`:
 *
 *   - `exit:<code>`      exits immediately with that code.
 *   - `term-exit:<code>` blocks (so the wrapper's `wait` blocks too) until it
 *                        receives TERM, then exits with that code — a
 *                        graceful shutdown.
 *   - `exit-when-both:<code>` waits until both `ui` and `serve` are in the
 *                        log, then exits with that code. A bare `exit:` for
 *                        the first process races the second one's start
 *                        under load: the script (rightly) stops `serve`
 *                        before it has logged anything.
 *   - unset (default)    blocks and exits 0 on TERM, same as `term-exit:0`.
 */
async function writeFakeNode(): Promise<void> {
  const path = join(binDir, 'node')
  await mkdir(binDir, { recursive: true })
  const script = [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$FAKE_LOG"',
    'case "${2:-}" in',
    '  setup)',
    '    mkdir -p "$(dirname "$MCPCUT_CONFIG")"',
    '    printf \'{"version":1}\\n\' > "$MCPCUT_CONFIG"',
    '    exit 0',
    '    ;;',
    '  ui) BEHAVIOR="${FAKE_UI_BEHAVIOR:-}" ;;',
    '  serve) BEHAVIOR="${FAKE_SERVE_BEHAVIOR:-}" ;;',
    '  *) exit 0 ;;',
    'esac',
    'case "$BEHAVIOR" in',
    '  exit-when-both:*)',
    '    i=0',
    '    while [ "$i" -lt 200 ]; do',
    '      if grep -q "cli.js ui" "$FAKE_LOG" && grep -q "cli.js serve" "$FAKE_LOG"; then break; fi',
    '      i=$((i + 1)); sleep 0.05',
    '    done',
    '    exit "${BEHAVIOR#exit-when-both:}" ;;',
    '  exit:*)',
    '    exit "${BEHAVIOR#exit:}" ;;',
    '  term-exit:*)',
    '    code="${BEHAVIOR#term-exit:}"',
    '    trap "exit $code" TERM',
    '    while :; do sleep 1; done ;;',
    '  *)',
    '    trap \'exit 0\' TERM',
    '    while :; do sleep 1; done ;;',
    'esac',
    '',
  ].join('\n')
  await writeFile(path, script, 'utf8')
  await chmod(path, FAKE_NODE_MODE)
}

/** The shell the image would use, when a test wants to pin POSIX-ness. */
function dashPath(): string | undefined {
  const found = spawnSync('/bin/sh', ['-c', 'command -v dash'], { encoding: 'utf8' })
  const path = found.stdout.trim()
  return found.status === 0 && path !== '' ? path : undefined
}

const DASH = dashPath()

interface RunResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly log: readonly string[]
}

interface RunOptions {
  /**
   * Signal to send to the script itself, once both `ui` and `serve` have
   * been invoked (polled from the log — see `waitForBothStarted`, below).
   * Sending it on a fixed delay instead would be flaky under load: this
   * script installs its own TERM/INT trap only after `first-start.sh` has
   * returned and both children are backgrounded, and a signal arriving
   * before that point hits the shell's default (kill-immediately)
   * disposition instead — which is a real, and in this narrow window
   * acceptable, gap (nothing has started yet to shut down gracefully), but
   * it would make a fixed-delay test flake under CI load rather than
   * testing the thing these tests are actually about.
   */
  readonly signal?: NodeJS.Signals
  /** Run under this shell instead of the script's own shebang. */
  readonly shell?: string
}

const POLL_INTERVAL_MS = 20
const POLL_TIMEOUT_MS = 5_000

function logPath(): string {
  return join(workDir, 'argv.log')
}

function configPath(): string {
  return join(workDir, 'config', 'config.json')
}

function loggedArgv(): readonly string[] {
  if (!existsSync(logPath())) return []
  return readFileSync(logPath(), 'utf8').split('\n').filter(Boolean)
}

/** Polls the argv log until both long-running commands have been launched. */
async function waitForBothStarted(): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const log = loggedArgv()
    if (log.includes('/app/dist/cli.js ui') && log.includes('/app/dist/cli.js serve')) return
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error('timed out waiting for both `ui` and `serve` to start')
}

/**
 * Runs `docker/tenant-run.sh` (or, under `shell`, that script interpreted by
 * a named shell), optionally sending it a signal once both children are up,
 * and resolves once it exits. A safety `SIGKILL` guards against the script
 * hanging and stalling the suite instead of failing the assertion.
 */
function runTenant(
  extraEnv: Readonly<Record<string, string>>,
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const args = options.shell === undefined ? [] : [TENANT_RUN]
    const child = spawn(options.shell ?? TENANT_RUN, args, {
      env: {
        PATH: `${binDir}${delimiter}${process.env['PATH'] ?? ''}`,
        FAKE_LOG: logPath(),
        MCPCUT_CONFIG: configPath(),
        ...extraEnv,
      },
    })
    spawned.push(child)

    if (options.signal !== undefined) {
      const signal = options.signal
      waitForBothStarted()
        .then(() => child.kill(signal))
        .catch((error: unknown) => reject(error instanceof Error ? error : new Error(String(error))))
    }
    const safetyTimer = setTimeout(() => child.kill('SIGKILL'), SAFETY_KILL_MS)

    child.on('error', (error) => {
      clearTimeout(safetyTimer)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(safetyTimer)
      resolve({ code, signal, log: loggedArgv() })
    })
  })
}

const SETUP_ARGV =
  '/app/dist/cli.js setup --yes --supervisor external ' +
  '--data-dir /home/node/.mcpcut/data ' +
  '--ui-host 0.0.0.0 --ui-port 8091 ' +
  '--serve-host 0.0.0.0 --serve-port 8090 ' +
  '--no-admin'

describe.skipIf(process.platform === 'win32')('docker/tenant-run.sh', () => {
  test(
    'first start writes the install config, then starts both `ui` and `serve`',
    async () => {
      // `ui` exits right away; the script's own logic (not a test-injected
      // signal) is what stops `serve` — see the timing note on `RunOptions`
      // for why this test avoids racing a fixed delay against a trap install.
      const result = await runTenant({ FAKE_UI_BEHAVIOR: 'exit-when-both:0', FAKE_SERVE_BEHAVIOR: 'term-exit:0' })

      expect(result.log[0]).toBe(SETUP_ARGV)
      expect(result.log).toContain('/app/dist/cli.js ui')
      expect(result.log).toContain('/app/dist/cli.js serve')
      expect(existsSync(configPath())).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    '`ui` exiting first sends TERM to `serve` and the script exits with `ui`\'s code',
    async () => {
      const result = await runTenant({ FAKE_UI_BEHAVIOR: 'exit-when-both:5', FAKE_SERVE_BEHAVIOR: 'term-exit:0' })

      expect(result.code).toBe(5)
      expect(result.signal).toBeNull()
    },
    TEST_TIMEOUT_MS,
  )

  test(
    '`serve` exiting first sends TERM to `ui` and the script exits with `serve`\'s code',
    async () => {
      const result = await runTenant({ FAKE_UI_BEHAVIOR: 'term-exit:0', FAKE_SERVE_BEHAVIOR: 'exit:9' })

      expect(result.code).toBe(9)
      expect(result.signal).toBeNull()
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'a non-zero exit from the survivor after TERM does not change the reported code',
    async () => {
      // `ui` dies first with 0 (a clean exit); `serve`, once forwarded TERM,
      // exits 1 instead of 0 (as if shutdown itself failed). The contract is
      // "the FIRST process to exit decides the code" — `serve`'s code here
      // must not leak into the result.
      const result = await runTenant({ FAKE_UI_BEHAVIOR: 'exit-when-both:0', FAKE_SERVE_BEHAVIOR: 'term-exit:1' })

      expect(result.code).toBe(0)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'TERM to the script is forwarded to both children; it exits 143 once both are done',
    async () => {
      const result = await runTenant(
        { FAKE_UI_BEHAVIOR: 'term-exit:0', FAKE_SERVE_BEHAVIOR: 'term-exit:0' },
        { signal: 'SIGTERM' },
      )

      expect(result.code).toBe(143)
      expect(result.signal).toBeNull()
      expect(result.log).toContain('/app/dist/cli.js ui')
      expect(result.log).toContain('/app/dist/cli.js serve')
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'INT to the script is forwarded to both children; it exits 130 once both are done',
    async () => {
      const result = await runTenant(
        { FAKE_UI_BEHAVIOR: 'term-exit:0', FAKE_SERVE_BEHAVIOR: 'term-exit:0' },
        { signal: 'SIGINT' },
      )

      expect(result.code).toBe(130)
      expect(result.signal).toBeNull()
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'a second start with an existing, non-empty config does not call setup',
    async () => {
      await mkdir(join(workDir, 'config'), { recursive: true })
      await writeFile(configPath(), '{"version":1}\n', 'utf8')

      const result = await runTenant({ FAKE_UI_BEHAVIOR: 'exit:0', FAKE_SERVE_BEHAVIOR: 'exit:0' })

      expect(result.log).not.toContain(SETUP_ARGV)
      expect(result.log.some((line) => line.includes('setup'))).toBe(false)
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(DASH === undefined)(
    'dash: TERM to the script is forwarded to both children and it exits 143',
    async () => {
      const result = await runTenant(
        { FAKE_UI_BEHAVIOR: 'term-exit:0', FAKE_SERVE_BEHAVIOR: 'term-exit:0' },
        { signal: 'SIGTERM', shell: DASH },
      )

      expect(result.code).toBe(143)
      expect(result.signal).toBeNull()
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(DASH === undefined)(
    'dash: INT to the script is forwarded to both children and it exits 130',
    async () => {
      const result = await runTenant(
        { FAKE_UI_BEHAVIOR: 'term-exit:0', FAKE_SERVE_BEHAVIOR: 'term-exit:0' },
        { signal: 'SIGINT', shell: DASH },
      )

      expect(result.code).toBe(130)
      expect(result.signal).toBeNull()
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(DASH === undefined)(
    'dash: `ui` exiting first sends TERM to `serve` and the script exits with `ui`\'s code',
    async () => {
      const result = await runTenant(
        { FAKE_UI_BEHAVIOR: 'exit-when-both:5', FAKE_SERVE_BEHAVIOR: 'term-exit:0' },
        { shell: DASH },
      )

      expect(result.code).toBe(5)
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(DASH === undefined)(
    'dash: a second start with an existing config does not call setup',
    async () => {
      await mkdir(join(workDir, 'config'), { recursive: true })
      await writeFile(configPath(), '{"version":1}\n', 'utf8')

      const result = await runTenant(
        { FAKE_UI_BEHAVIOR: 'exit:0', FAKE_SERVE_BEHAVIOR: 'exit:0' },
        { shell: DASH },
      )

      expect(result.log.some((line) => line.includes('setup'))).toBe(false)
    },
    TEST_TIMEOUT_MS,
  )
})
