import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { createAdminStore } from '../../../src/admin/store.js'
import type { CliIo, DispatchFn, DispatchOptions } from '../../../src/cli/dispatch-types.js'
import type { Msg, RunRequest } from '../../../src/tui/model.js'
import {
  createTokenCell,
  executeEffect,
  type EffectDeps,
  type TokenCell,
} from '../../../src/tui/runtime-effects.js'

/**
 * The stand the effect-executor suites share: `runtime-effects.test.ts`
 * (cells, sign-in, the header refresh, poll, reopen, the wizard rungs, quit),
 * `runtime-effects-run.test.ts` (`run` and the secret on stdin) and
 * `runtime-effects-sink.test.ts` (stdout to a file). Lifted out of
 * `runtime-effects.test.ts` when it was split (phase 6, task 9, F9).
 *
 * The store is real and lives in a temp journal directory, the way
 * `tests/cli/admin-cmd.test.ts` builds one — the freshness check is exactly
 * the store lookup the web UI does, and a fake would prove nothing about it.
 * The directory is per test: a suite calls `openEffectsJournalDir` in a
 * `beforeEach` and `disposeEffectsJournalDir` in an `afterEach`, and reads it
 * back through `journalDirOf`.
 */

export const ADMIN_NAME = 'alice'
export const OTHER_ENV: NodeJS.ProcessEnv = { PATH: '/usr/bin' }

let journalDir: string | undefined

/** Makes the temp journal directory the next test runs against; for a `beforeEach`. */
export async function openEffectsJournalDir(): Promise<void> {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-runtime-effects-'))
}

/** Removes it again; for an `afterEach`. */
export async function disposeEffectsJournalDir(): Promise<void> {
  if (journalDir === undefined) return
  await rm(journalDir, { recursive: true, force: true })
  journalDir = undefined
}

/** The journal directory of the test that is running. */
export function journalDirOf(): string {
  if (journalDir === undefined) {
    throw new Error('no journal directory: call openEffectsJournalDir() in a beforeEach')
  }
  return journalDir
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface DispatchCall {
  readonly argv: readonly string[]
  readonly opts: DispatchOptions | undefined
}

export interface RecordingDispatch {
  readonly fn: DispatchFn
  readonly calls: readonly DispatchCall[]
}

/** What a fake `dispatch` does with the io it is handed, before it answers. */
export type DispatchBehaviour = (io: CliIo) => number | Promise<number>

/** A `dispatch` that remembers how it was called and answers as told. */
export function recordingDispatch(behaviour: DispatchBehaviour = () => 0): RecordingDispatch {
  const calls: DispatchCall[] = []
  return {
    calls,
    fn: async (argv, io, opts) => {
      calls.push({ argv, opts })
      return behaviour(io)
    },
  }
}

/** A base with plain data only, so `structuredClone` can prove it survived a run. */
export function baseOptions(): DispatchOptions {
  const dir = journalDirOf()
  return { journalDir: dir, admin: { journalDir: dir } }
}

export function depsOf(dispatch: DispatchFn, token: TokenCell): EffectDeps {
  return { dispatch, dispatchOptions: baseOptions(), env: OTHER_ENV, journalDir: journalDirOf(), token }
}

/** An admin in the temp store, with the one-time token the console signs in with. */
export async function createTestAdmin(): Promise<string> {
  const store = createAdminStore({ journalDir: journalDirOf() })
  const created = await store.createAdmin(ADMIN_NAME, 'owner')
  return created.token
}

/** A signed-in cell: the token is in it because `signin` put it there. */
export async function signedInCell(): Promise<{ cell: TokenCell; token: string }> {
  const token = await createTestAdmin()
  const cell = createTokenCell()
  const message = await executeEffect(
    { kind: 'signin', token },
    depsOf(recordingDispatch().fn, cell),
  )
  expect(message).toEqual({
    kind: 'signin-result',
    result: { kind: 'ok', name: ADMIN_NAME, role: 'owner' },
  })
  return { cell, token }
}

export const RUN_REQUEST: RunRequest = {
  actionId: 'admin.list',
  argv: ['admin', 'list'],
  display: ['admin', 'list'],
}

/**
 * The request `JOURNAL_SECTION`'s `export` really builds: the path is NOT in
 * argv (the command has no `--out` of its own — that flag belongs to `export
 * --report`), it is the `stdoutToField` the runtime opens the file from.
 */
export function exportRequest(stdoutPath: string): RunRequest {
  return {
    actionId: 'journal.export',
    argv: ['export'],
    display: ['export'],
    stdoutPath,
  }
}

/** The `Msg` a run answered with, or a failure naming what came back instead. */
export function runResultOf(message: Msg | undefined): Extract<Msg, { kind: 'run-result' }> {
  if (message?.kind !== 'run-result') throw new Error(`expected a run-result, got ${message?.kind}`)
  return message
}
