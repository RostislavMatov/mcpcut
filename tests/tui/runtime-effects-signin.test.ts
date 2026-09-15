import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { bootstrapTokenPathFor, writeBootstrapTokenFile } from '../../src/admin/bootstrap-file.js'
import { createAdminStore } from '../../src/admin/store.js'
import type { CliWritable, DispatchFn } from '../../src/cli/dispatch-types.js'
import { errnoCodeOf } from '../../src/errno.js'
import {
  createTokenCell,
  executeEffect,
  type EffectDeps,
  type TokenCell,
} from '../../src/tui/runtime-effects.js'
import { BOOTSTRAP_FILE_WARNING_PREFIX } from '../../src/tui/runtime-signin.js'

/**
 * The console's half of the one-time bootstrap token file (phase 6, F6 /
 * Q27). The web UI removes the file on its first login; the console removes
 * it on its first successful sign-in, through the same `consumeBootstrapTokenFile`.
 *
 * Three things are pinned. The file goes with the FIRST successful sign-in
 * and stays through a refused one — a wrong token must not destroy the
 * credential someone else still needs. A file that cannot be removed is one
 * line of stderr and nothing else: the sign-in result is what it would have
 * been, because an operator who is in must not be kept out by an unlink. And
 * the effect harness runs without a stderr seam at all, in which case the
 * failure is simply not reported — never thrown.
 *
 * New file rather than a section of `runtime-effects.test.ts`, which is past
 * the file budget and is split along its own lines in a later task (F9).
 */

const ADMIN_NAME = 'alice'
const OTHER_ENV: NodeJS.ProcessEnv = { PATH: '/usr/bin' }

/** A `dispatch` that answers success; nothing here runs a command. */
const quietDispatch: DispatchFn = async () => 0

let journalDir: string
let tokenPath: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-effects-signin-'))
  tokenPath = bootstrapTokenPathFor(journalDir)
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

interface StderrSink extends CliWritable {
  text(): string
}

function stderrSink(): StderrSink {
  const chunks: string[] = []
  return {
    write: (chunk: string) => chunks.push(chunk),
    text: () => chunks.join(''),
  }
}

function depsOf(token: TokenCell, stderr?: CliWritable): EffectDeps {
  return {
    dispatch: quietDispatch,
    dispatchOptions: { journalDir, admin: { journalDir } },
    env: OTHER_ENV,
    journalDir,
    token,
    ...(stderr !== undefined ? { stderr } : {}),
  }
}

/** An admin in the temp store, with the token the console signs in with. */
async function createTestAdmin(name = ADMIN_NAME): Promise<string> {
  const created = await createAdminStore({ journalDir }).createAdmin(name, 'owner')
  return created.token
}

/** Whether the bootstrap file is on disk; `ENOENT` is the one absence that counts. */
async function fileExists(): Promise<boolean> {
  try {
    await stat(tokenPath)
    return true
  } catch (error: unknown) {
    if (errnoCodeOf(error) === 'ENOENT') return false
    throw error
  }
}

describe('executeEffect — signin removes the bootstrap token file', () => {
  test('a successful sign-in removes the file, and says nothing about it', async () => {
    const token = await createTestAdmin()
    await writeBootstrapTokenFile(tokenPath, token)
    const cell = createTokenCell()
    const stderr = stderrSink()

    const message = await executeEffect({ kind: 'signin', token }, depsOf(cell, stderr))

    expect(message).toEqual({
      kind: 'signin-result',
      result: { kind: 'ok', name: ADMIN_NAME, role: 'owner' },
    })
    expect(cell.get()).toBe(token)
    expect(await fileExists()).toBe(false)
    expect(stderr.text()).toBe('')
  })

  test('a refused token leaves the file where it is', async () => {
    const token = await createTestAdmin()
    await writeBootstrapTokenFile(tokenPath, token)
    const stderr = stderrSink()

    const message = await executeEffect(
      { kind: 'signin', token: 'mcpa_not-an-admin' },
      depsOf(createTokenCell(), stderr),
    )

    expect(message).toEqual({ kind: 'signin-result', result: { kind: 'unknown' } })
    expect(await fileExists()).toBe(true)
    expect(stderr.text()).toBe('')
  })

  test('a second sign-in finds no file and says nothing', async () => {
    const token = await createTestAdmin()
    await writeBootstrapTokenFile(tokenPath, token)
    const stderr = stderrSink()
    await executeEffect({ kind: 'signin', token }, depsOf(createTokenCell(), stderr))

    const second = await executeEffect({ kind: 'signin', token }, depsOf(createTokenCell(), stderr))

    expect(second?.kind).toBe('signin-result')
    expect(await fileExists()).toBe(false)
    expect(stderr.text()).toBe('')
  })

  test('a file that cannot be removed is one stderr line, and the sign-in still succeeds', async () => {
    const token = await createTestAdmin()
    // A directory with a child at the path: `unlink` refuses it, the way
    // `tests/admin/bootstrap-file.test.ts` forces the same failure.
    await mkdir(tokenPath)
    await writeFile(join(tokenPath, 'child'), '', 'utf8')
    const cell = createTokenCell()
    const stderr = stderrSink()

    const message = await executeEffect({ kind: 'signin', token }, depsOf(cell, stderr))

    expect(message).toEqual({
      kind: 'signin-result',
      result: { kind: 'ok', name: ADMIN_NAME, role: 'owner' },
    })
    expect(cell.get()).toBe(token)
    const lines = stderr.text().split('\n').filter((line) => line !== '')
    expect(lines).toHaveLength(1)
    expect(lines[0]?.startsWith(BOOTSTRAP_FILE_WARNING_PREFIX)).toBe(true)
    expect(lines[0]?.length).toBeGreaterThan(BOOTSTRAP_FILE_WARNING_PREFIX.length)
    expect((await stat(tokenPath)).isDirectory()).toBe(true)
  })

  test('without a stderr seam the failure is not thrown either', async () => {
    const token = await createTestAdmin()
    await mkdir(tokenPath)
    await writeFile(join(tokenPath, 'child'), '', 'utf8')
    const cell = createTokenCell()

    const message = await executeEffect({ kind: 'signin', token }, depsOf(cell))

    expect(message?.kind).toBe('signin-result')
    expect(cell.get()).toBe(token)
  })
})
