import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { dispatch } from '../../src/cli.js'
import type { NpmInvocation } from '../../src/cli/files-db-seams.js'
import { PG_PACKAGE_VERSION } from '../../src/files/db/constants.js'
import { MODULES_PACKAGE_JSON, MODULES_PACKAGE_LOCK } from '../../src/files/db/modules-lock.js'
import { loadPg } from '../../src/files/db/pg-loader.js'

/** `mcpcut files setup` with a fake npm runner: nothing here touches the network. */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-files-setup-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

async function setup(
  runNpm: (invocation: NpmInvocation) => Promise<number>,
  extra: { platform?: NodeJS.Platform; args?: string[] } = {},
) {
  const out: string[] = []
  const err: string[] = []
  const io = { stdout: { write: (chunk: string) => out.push(chunk) }, stderr: { write: (chunk: string) => err.push(chunk) } }
  const code = await dispatch(['files', 'setup', ...(extra.args ?? [])], io, {
    files: {
      journalDir,
      env: {},
      db: { runNpm, loadPg: () => loadPg(process.cwd()), ...(extra.platform !== undefined ? { platform: extra.platform } : {}) },
    },
  })
  return { code, out: out.join(''), err: err.join('') }
}

/** A runner that "installs" pg by writing the manifest `npm ci` would leave. */
function installingRunner(calls: NpmInvocation[]) {
  return async (invocation: NpmInvocation): Promise<number> => {
    calls.push(invocation)
    const pgDir = join(invocation.cwd, 'node_modules', 'pg')
    await mkdir(pgDir, { recursive: true })
    await writeFile(join(pgDir, 'package.json'), JSON.stringify({ name: 'pg', version: PG_PACKAGE_VERSION }))
    return 0
  }
}

describe('files setup', () => {
  test('writes the pinned package.json and lock, runs npm ci with constant arguments, ends with the next step', async () => {
    const calls: NpmInvocation[] = []
    const result = await setup(installingRunner(calls))

    expect(result.code).toBe(0)
    const modulesDir = join(journalDir, 'modules')
    expect(JSON.parse(await readFile(join(modulesDir, 'package.json'), 'utf8'))).toEqual(MODULES_PACKAGE_JSON)
    expect(JSON.parse(await readFile(join(modulesDir, 'package-lock.json'), 'utf8'))).toEqual(MODULES_PACKAGE_LOCK)
    expect((await stat(modulesDir)).mode & 0o777).toBe(0o700)
    expect(calls).toEqual([
      { command: 'npm', args: ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier'], cwd: modulesDir, shell: false },
    ])
    expect(result.out).toContain(`installed pg ${PG_PACKAGE_VERSION}`)
    expect(result.out.trimEnd().split('\n').at(-1)).toBe('Optional: `mcpcut files setup --search` adds search by meaning (downloads ≈ 430 MB)')
    expect(result.err.trimEnd().split('\n').at(-1)).toBe('Next: mcpcut files db init')
  })

  test('uses npm.cmd through a shell on win32', async () => {
    const calls: NpmInvocation[] = []
    await setup(installingRunner(calls), { platform: 'win32' })
    expect(calls[0]).toMatchObject({ command: 'npm.cmd', shell: true })
  })

  test('a failing npm is one line with the exit code and the retry step', async () => {
    const result = await setup(async () => 7)
    expect(result.code).toBe(1)
    expect(result.err).toBe('npm exited with code 7: check your network and run `mcpcut files setup` again\n')
  })

  test('an npm that cannot start says so and what to do', async () => {
    const result = await setup(async () => {
      throw new Error('spawn npm ENOENT')
    })
    expect(result.code).toBe(1)
    expect(result.err).toContain('could not run npm (spawn npm ENOENT)')
    expect(result.err).toContain('run `mcpcut files setup` again')
  })

  test('npm succeeding without a loadable client is refused', async () => {
    const out: string[] = []
    const err: string[] = []
    const code = await dispatch(['files', 'setup'], { stdout: { write: (c: string) => out.push(c) }, stderr: { write: (c: string) => err.push(c) } }, {
      files: { journalDir, env: {}, db: { runNpm: async () => 0, loadPg: async () => { throw new Error('nope') } } },
    })
    expect(code).toBe(1)
    expect(err.join('')).toContain('cannot be loaded (nope)')
  })

  test('skips npm when the pinned version is already installed', async () => {
    const calls: NpmInvocation[] = []
    await setup(installingRunner(calls))
    const again = await setup(async () => {
      throw new Error('npm must not run')
    })
    expect(again.code).toBe(0)
    expect(again.out).toContain('is already installed')
    expect(again.err).toBe('Next: mcpcut files db init\n')
  })

  test('rejects stray arguments', async () => {
    const result = await setup(async () => 0, { args: ['--force'] })
    expect(result.code).toBe(1)
    expect(result.err).toBe('usage: mcpcut files setup [--search]\n')
  })
})
