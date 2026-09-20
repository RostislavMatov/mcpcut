import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

/**
 * `docker/entrypoint.sh` (mcpcut phase 3, Task 12): the first start of a
 * service container turns `MCPCUT_*` into the install config by running
 * `setup --yes --supervisor external`, then `exec`s the CLI.
 *
 * The script is shell, so it is tested the way shell can be tested: a fake
 * `node` earlier on `PATH` records the argv it was called with and, for the
 * `setup` call, WRITES the config file the second start must find. That pins
 * the three things the image depends on — the exact `setup` command line, the
 * "exactly once" condition, and the fact that an EMPTY file is not an install
 * — without building an image.
 *
 * The script is run the way the image runs it: `spawnSync(ENTRYPOINT)`, so
 * the exec bit and the `#!/bin/sh` line are under test too, and once more
 * under `dash` where the box has one, because the image's `/bin/sh` is not
 * bash.
 */

const ENTRYPOINT = join(process.cwd(), 'docker', 'entrypoint.sh')
const FAKE_NODE_MODE = 0o755

const SETUP_ARGV =
  '/app/dist/cli.js setup --yes --supervisor external ' +
  '--data-dir /home/node/.mcpcut/data ' +
  '--ui-host 0.0.0.0 --ui-port 8091 ' +
  '--serve-host 0.0.0.0 --serve-port 8090 ' +
  '--no-admin'

let workDir: string
let binDir: string
let logPath: string
let configPath: string

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mcpcut-entrypoint-'))
  binDir = join(workDir, 'bin')
  logPath = join(workDir, 'argv.log')
  configPath = join(workDir, 'config', 'config.json')
  await writeFakeNode()
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

/**
 * Stands in for `node` inside the image: appends its argv as one line to
 * `$FAKE_LOG` and, when it is the `setup` call (`$2`), writes the config
 * file — which is what makes a second run take the "already installed" path.
 * The content is not empty on purpose: the script asks whether the file HAS
 * something in it, not merely whether it exists.
 */
async function writeFakeNode(): Promise<void> {
  const path = join(binDir, 'node')
  await mkdir(binDir, { recursive: true })
  const script = [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$FAKE_LOG"',
    'if [ "${2:-}" = "setup" ]; then',
    '  mkdir -p "$(dirname "$MCPCUT_CONFIG")"',
    '  printf \'{"version":1}\\n\' > "$MCPCUT_CONFIG"',
    'fi',
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

/**
 * Runs the script as the image does — by its own path, on its own shebang —
 * unless a test names a shell to run it under instead.
 */
function runEntrypoint(
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
  shell?: string,
): { readonly status: number | null; readonly stderr: string } {
  const argv = shell === undefined ? [...args] : [ENTRYPOINT, ...args]
  const result = spawnSync(shell ?? ENTRYPOINT, argv, {
    encoding: 'utf8',
    env: {
      PATH: `${binDir}${delimiter}${process.env['PATH'] ?? ''}`,
      FAKE_LOG: logPath,
      MCPCUT_CONFIG: configPath,
      ...extraEnv,
    },
  })
  return { status: result.status, stderr: result.stderr }
}

function loggedArgv(): readonly string[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
}

describe.skipIf(process.platform === 'win32')('docker/entrypoint.sh', () => {
  test('first `ui` start writes the install config, then execs the ui command', () => {
    const { status, stderr } = runEntrypoint(['ui'])

    expect(stderr).toBe('')
    expect(status).toBe(0)
    expect(loggedArgv()).toEqual([SETUP_ARGV, '/app/dist/cli.js ui'])
    expect(existsSync(configPath)).toBe(true)
  })

  test('second start finds the config and runs the command only', () => {
    runEntrypoint(['ui'])
    runEntrypoint(['ui'])

    expect(loggedArgv()).toEqual([SETUP_ARGV, '/app/dist/cli.js ui', '/app/dist/cli.js ui'])
  })

  test('`serve` with an existing config runs the command only', () => {
    runEntrypoint(['ui'])
    runEntrypoint(['serve'])

    expect(loggedArgv()).toEqual([SETUP_ARGV, '/app/dist/cli.js ui', '/app/dist/cli.js serve'])
  })

  test('MCPCUT_UI_PORT overrides the port the setup call is given', () => {
    runEntrypoint(['ui'], { MCPCUT_UI_PORT: '9000' })

    expect(loggedArgv()[0]).toContain('--ui-port 9000')
    expect(loggedArgv()[0]).not.toContain('--ui-port 8091')
  })

  /**
   * Q32 follow-up: the probe hosts are the compose service names, which only
   * resolve on the compose project network. On a bare `docker run` a default
   * of `ui`/`serve` would persist names that never resolve, and the
   * container's own UI would read `stopped` — so without the variables the
   * flags are absent and `setup` keeps its own default.
   */
  test('without the probe-host variables the setup call carries no probe-host flags', () => {
    runEntrypoint(['ui'])

    expect(loggedArgv()[0]).not.toContain('--ui-probe-host')
    expect(loggedArgv()[0]).not.toContain('--serve-probe-host')
  })

  test('MCPCUT_SERVE_PROBE_HOST adds the serve probe-host flag to the setup call', () => {
    runEntrypoint(['ui'], { MCPCUT_SERVE_PROBE_HOST: 'plane-serve' })

    expect(loggedArgv()[0]).toContain('--serve-probe-host plane-serve ')
    expect(loggedArgv()[0]).not.toContain('--ui-probe-host')
  })

  test('MCPCUT_UI_PROBE_HOST adds the ui probe-host flag to the setup call', () => {
    runEntrypoint(['serve'], { MCPCUT_UI_PROBE_HOST: 'plane-ui' })

    expect(loggedArgv()[0]).toContain('--ui-probe-host plane-ui ')
    expect(loggedArgv()[0]).not.toContain('--serve-probe-host')
  })

  test('MCPCUT_UI_PUBLIC_URL / MCPCUT_SERVE_PUBLIC_URL become the public-url flags, each only when set', () => {
    runEntrypoint(['ui'], { MCPCUT_UI_PUBLIC_URL: 'http://203.0.113.7:8091' })

    expect(loggedArgv()[0]).toContain('--ui-public-url http://203.0.113.7:8091 ')
    expect(loggedArgv()[0]).not.toContain('--serve-public-url')
  })

  test('both public-url variables, and an empty one adds no flag', async () => {
    runEntrypoint(['ui'], { MCPCUT_UI_PUBLIC_URL: '', MCPCUT_SERVE_PUBLIC_URL: 'https://agents.example.com' })

    expect(loggedArgv()[0]).toContain('--serve-public-url https://agents.example.com ')
    expect(loggedArgv()[0]).not.toContain('--ui-public-url')
  })

  test('an empty probe-host variable adds no flag', () => {
    runEntrypoint(['ui'], { MCPCUT_UI_PROBE_HOST: '', MCPCUT_SERVE_PROBE_HOST: '' })

    expect(loggedArgv()[0]).toBe(SETUP_ARGV)
  })

  test.skipIf(DASH === undefined)('dash passes both probe-host flags when both variables are set', () => {
    const { status, stderr } = runEntrypoint(
      ['ui'],
      { MCPCUT_UI_PROBE_HOST: 'ui', MCPCUT_SERVE_PROBE_HOST: 'serve' },
      DASH,
    )

    expect(stderr).toBe('')
    expect(status).toBe(0)
    expect(loggedArgv()[0]).toBe(
      SETUP_ARGV.replace(' --no-admin', ' --ui-probe-host ui --serve-probe-host serve --no-admin'),
    )
  })

  test('a non-service command never triggers setup', () => {
    const { status } = runEntrypoint(['--help'])

    expect(status).toBe(0)
    expect(loggedArgv()).toEqual(['/app/dist/cli.js --help'])
    expect(existsSync(configPath)).toBe(false)
  })

  /**
   * A zero-byte file on the config volume is what a killed first start, or a
   * `touch`, leaves behind. Treated as an install it would skip `setup`
   * forever, and every start after it would die on a config it cannot read —
   * a crash loop with `restart: unless-stopped` behind it.
   */
  test('an empty config file is not an install, so setup runs again', async () => {
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, '', 'utf8')

    const { status } = runEntrypoint(['ui'])

    expect(status).toBe(0)
    expect(loggedArgv()).toEqual([SETUP_ARGV, '/app/dist/cli.js ui'])
    expect(readFileSync(configPath, 'utf8')).not.toBe('')
  })

  test.skipIf(DASH === undefined)('the script is POSIX shell: dash runs it too', () => {
    const { status, stderr } = runEntrypoint(['ui'], {}, DASH)

    expect(stderr).toBe('')
    expect(status).toBe(0)
    expect(loggedArgv()).toEqual([SETUP_ARGV, '/app/dist/cli.js ui'])
  })
})
