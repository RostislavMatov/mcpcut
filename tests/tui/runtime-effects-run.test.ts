import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import type { DispatchFn } from '../../src/cli/dispatch-types.js'
import type { RunRequest } from '../../src/tui/model.js'
import { createTokenCell, executeEffect } from '../../src/tui/runtime-effects.js'
import { SESSION_ENV_SEAMS } from '../../src/tui/session-env.js'
import {
  ADMIN_NAME,
  RUN_REQUEST,
  depsOf,
  disposeEffectsJournalDir,
  journalDirOf,
  openEffectsJournalDir,
  recordingDispatch,
  runResultOf,
  signedInCell,
} from './support/effects-harness.js'

/**
 * The `run` effect of the executor: the token on the env seams and nowhere
 * else, the session re-resolved before every run, a throwing or ill-answering
 * command folded into a failed run — and the vault secret that travels on
 * `Effect.stdin` (phase 4, task 8). Split out of `runtime-effects.test.ts`
 * (phase 6, task 9); the stand is `support/effects-harness.ts`.
 */

beforeEach(openEffectsJournalDir)
afterEach(disposeEffectsJournalDir)

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

describe('executeEffect — run', () => {
  test('the token travels on every env seam and in no argv element', async () => {
    const { cell, token } = await signedInCell()
    const dispatch = recordingDispatch((io) => {
      io.stdout.write('alice  owner\n')
      io.stderr.write('a warning\n')
      return 0
    })

    const message = await executeEffect(
      { kind: 'run', request: RUN_REQUEST },
      depsOf(dispatch.fn, cell),
    )

    const call = dispatch.calls[0]
    expect(call).toBeDefined()
    for (const seam of SESSION_ENV_SEAMS) {
      expect(call?.opts?.[seam]?.env?.[ADMIN_TOKEN_ENV_VAR]).toBe(token)
    }
    expect(call?.argv).toEqual(['admin', 'list'])
    expect(call?.argv.some((argument) => argument.includes(token))).toBe(false)
    expect(message).toEqual({
      kind: 'run-result',
      result: {
        argv: ['admin', 'list'],
        display: ['admin', 'list'],
        exitCode: 0,
        stdout: 'alice  owner\n',
        stderr: 'a warning\n',
      },
    })
    expect(JSON.stringify(message)).not.toContain(token)
  })

  test('the dispatch options handed in are not mutated', async () => {
    const { cell } = await signedInCell()
    const deps = depsOf(recordingDispatch().fn, cell)
    const before = structuredClone(deps.dispatchOptions)

    await executeEffect({ kind: 'run', request: RUN_REQUEST }, deps)

    expect(structuredClone(deps.dispatchOptions)).toEqual(before)
  })

  test('the display argv is passed through untouched', async () => {
    const { cell } = await signedInCell()
    const request: RunRequest = {
      actionId: 'admin.add',
      argv: ['admin', 'add', 'bob', '--role', 'operator'],
      display: ['admin', 'add', 'bob', '--role', '<masked>'],
    }

    const message = await executeEffect({ kind: 'run', request }, depsOf(recordingDispatch().fn, cell))

    expect(runResultOf(message).result.display).toEqual([
      'admin',
      'add',
      'bob',
      '--role',
      '<masked>',
    ])
  })

  test('no session at all is a lost session, and nothing is dispatched', async () => {
    const dispatch = recordingDispatch()

    const message = await executeEffect(
      { kind: 'run', request: RUN_REQUEST },
      depsOf(dispatch.fn, createTokenCell()),
    )

    expect(message).toEqual({ kind: 'session-lost' })
    expect(dispatch.calls).toHaveLength(0)
  })

  test('a token rotated from a shell loses the session and empties the cell', async () => {
    const { cell } = await signedInCell()
    const dispatch = recordingDispatch()
    await createAdminStore({ journalDir: journalDirOf() }).rotateAdmin(ADMIN_NAME)

    const message = await executeEffect(
      { kind: 'run', request: RUN_REQUEST },
      depsOf(dispatch.fn, cell),
    )

    expect(message).toEqual({ kind: 'session-lost' })
    expect(cell.get()).toBeUndefined()
    expect(dispatch.calls).toHaveLength(0)
  })

  test('a command that throws becomes a failed run, not a crashed console', async () => {
    const { cell } = await signedInCell()
    const dispatch = recordingDispatch((io) => {
      io.stdout.write('partial output\n')
      throw new Error('the store is on fire')
    })

    const message = await executeEffect(
      { kind: 'run', request: RUN_REQUEST },
      depsOf(dispatch.fn, cell),
    )

    const { result } = runResultOf(message)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('partial output\n')
    expect(result.stderr).toContain('the store is on fire')
  })

  test('the failure goes on its own line after unterminated output', async () => {
    const { cell } = await signedInCell()
    const dispatch = recordingDispatch((io) => {
      io.stderr.write('half a warning')
      throw new Error('and then it died')
    })

    const message = await executeEffect(
      { kind: 'run', request: RUN_REQUEST },
      depsOf(dispatch.fn, cell),
    )

    expect(runResultOf(message).result.stderr).toBe('half a warning\nand then it died\n')
  })

  test('a thrown non-error is described rather than dropped', async () => {
    const { cell } = await signedInCell()
    const dispatch = recordingDispatch(() => {
      throw 'plain string failure'
    })

    const message = await executeEffect(
      { kind: 'run', request: RUN_REQUEST },
      depsOf(dispatch.fn, cell),
    )

    expect(runResultOf(message).result.stderr).toContain('plain string failure')
  })

  test.each([
    ['NaN', Number.NaN],
    ['a fraction', 1.5],
    ['nothing at all', undefined],
    ['a string', '0'],
  ])('an answer that is not an exit code (%s) becomes exit 1', async (_label, answer) => {
    const { cell } = await signedInCell()
    const dispatch: DispatchFn = () => Promise.resolve(answer as number)

    const message = await executeEffect({ kind: 'run', request: RUN_REQUEST }, depsOf(dispatch, cell))

    expect(runResultOf(message).result.exitCode).toBe(1)
  })

  test('a real exit code is reported as it came back', async () => {
    const { cell } = await signedInCell()
    const dispatch = recordingDispatch((io) => {
      io.stderr.write('no such admin\n')
      return 1
    })

    const message = await executeEffect(
      { kind: 'run', request: RUN_REQUEST },
      depsOf(dispatch.fn, cell),
    )

    expect(runResultOf(message).result.exitCode).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// run — the secret seam and the file sink (mcpcut phase 4, task 8)
// ---------------------------------------------------------------------------

/**
 * The two runtime seams the catalogue needed. A vault secret travels in
 * `Effect.stdin` and reaches `vault.readSecretInput` — never argv, which the
 * output pane prints back, and never a `Msg`, which is what a frame is drawn
 * from. A `stdoutPath` sends the command's stdout to a file created `wx` at
 * 0600, and the pane shows a one-line receipt instead of an unbounded export.
 *
 * Every way the file can refuse — a path that is taken, a directory that is
 * not there — is an ordinary failed run: the console survives it, and the
 * command is not dispatched at all, because there is nowhere to put what it
 * would print.
 */
describe('executeEffect — run with a secret on stdin', () => {
  const VAULT_REQUEST: RunRequest = {
    actionId: 'vault.set',
    argv: ['vault', 'set', 'github-token'],
    display: ['vault', 'set', 'github-token'],
  }
  const SECRET = 'ghp_the-actual-secret-value'

  test('the secret reaches the vault seam, and no argv, frame or message holds it', async () => {
    const { cell, token } = await signedInCell()
    const dispatch = recordingDispatch((io) => {
      io.stdout.write('secret "github-token" set\n')
      return 0
    })

    const message = await executeEffect(
      { kind: 'run', request: VAULT_REQUEST, stdin: SECRET },
      depsOf(dispatch.fn, cell),
    )

    const call = dispatch.calls[0]
    await expect(call?.opts?.vault?.readSecretInput?.()).resolves.toBe(SECRET)
    expect(call?.opts?.vault?.env?.[ADMIN_TOKEN_ENV_VAR]).toBe(token)
    expect(call?.argv).toEqual(['vault', 'set', 'github-token'])
    expect(JSON.stringify(call?.argv)).not.toContain(SECRET)
    expect(JSON.stringify(message)).not.toContain(SECRET)
    expect(runResultOf(message).result.exitCode).toBe(0)
  })

  test('a run without a secret leaves the vault reader as the caller had it', async () => {
    const { cell } = await signedInCell()
    const dispatch = recordingDispatch()

    await executeEffect({ kind: 'run', request: VAULT_REQUEST }, depsOf(dispatch.fn, cell))

    expect(dispatch.calls[0]?.opts?.vault?.readSecretInput).toBeUndefined()
  })

  test('the base options are not mutated by the secret seam', async () => {
    const { cell } = await signedInCell()
    const deps = depsOf(recordingDispatch().fn, cell)
    const before = structuredClone(deps.dispatchOptions)

    await executeEffect({ kind: 'run', request: VAULT_REQUEST, stdin: SECRET }, deps)

    expect(structuredClone(deps.dispatchOptions)).toEqual(before)
    expect(deps.dispatchOptions.vault?.readSecretInput).toBeUndefined()
  })
})
