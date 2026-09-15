import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMINS_FILE_NAME, ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { statusJson } from '../../src/services/format.js'
import type { ServiceStatus } from '../../src/services/manager-types.js'
import { OUTPUT_CUT_NOTE, OUTPUT_MAX_CHARS } from '../../src/tui/constants.js'
import type { Effect, Msg, RunRequest } from '../../src/tui/model.js'
import {
  createReopenCell,
  createTokenCell,
  createWizardOutcomeCell,
  executeEffect,
  type EffectDeps,
} from '../../src/tui/runtime-effects.js'
import { SESSION_ENV_SEAMS, withoutAdminToken } from '../../src/tui/session-env.js'
import {
  ADMIN_NAME,
  OTHER_ENV,
  RUN_REQUEST,
  createTestAdmin,
  depsOf,
  disposeEffectsJournalDir,
  journalDirOf,
  openEffectsJournalDir,
  recordingDispatch,
  runResultOf,
  signedInCell,
} from './support/effects-harness.js'

/**
 * The effect executor (mcpcut phase 2, task 12): the only module that holds
 * the session token, and therefore the one whose tests carry the security
 * assertions of the console.
 *
 * Three properties are pinned here. The token reaches `dispatch` through the
 * `env` seams and NOWHERE else — not in argv, which the output pane prints
 * back verbatim, and not in a returned `Msg`, which is what a frame is
 * rendered from. The session is re-resolved before every run, so an admin
 * rotated or removed from a shell stops working in an already-open console
 * instead of surviving until it is restarted. And no command can take the
 * console down: a `dispatch` that throws, or answers with something that is
 * not an exit code, becomes an ordinary failed run in the output pane.
 *
 * This file holds the cells, sign-in, the header refresh, poll, reopen, the
 * wizard rungs and quit. The `run` effect itself is in
 * `runtime-effects-run.test.ts` and its file sink in
 * `runtime-effects-sink.test.ts` (split in phase 6, task 9); the stand they
 * all share — a real store in a temp journal directory — is
 * `support/effects-harness.ts`.
 */

const STATUSES: readonly ServiceStatus[] = [
  { service: 'ui', state: 'running', host: '127.0.0.1', port: 8091, pid: 4321, logPath: '/logs/ui.log' },
  { service: 'serve', state: 'stopped', host: '127.0.0.1', port: 8090, logPath: '/logs/serve.log' },
]

beforeEach(openEffectsJournalDir)
afterEach(disposeEffectsJournalDir)

// ---------------------------------------------------------------------------
// createTokenCell
// ---------------------------------------------------------------------------

describe('createTokenCell', () => {
  test('starts empty, holds what it is given, and can be emptied again', () => {
    const cell = createTokenCell()

    expect(cell.get()).toBeUndefined()

    cell.set('mcpa_token')
    expect(cell.get()).toBe('mcpa_token')

    cell.set(undefined)
    expect(cell.get()).toBeUndefined()
  })

  test('two cells do not share state', () => {
    const first = createTokenCell()
    const second = createTokenCell()

    first.set('mcpa_first')

    expect(second.get()).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// signin
// ---------------------------------------------------------------------------

describe('executeEffect — signin', () => {
  test('a token the store knows names the admin and is kept for the session', async () => {
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
    expect(cell.get()).toBe(token)
  })

  test('a token the store does not know leaves the cell empty', async () => {
    await createTestAdmin()
    const cell = createTokenCell()

    const message = await executeEffect(
      { kind: 'signin', token: 'mcpa_not-an-admin' },
      depsOf(recordingDispatch().fn, cell),
    )

    expect(message).toEqual({ kind: 'signin-result', result: { kind: 'unknown' } })
    expect(cell.get()).toBeUndefined()
  })

  test('an unreadable admin store answers with a detail instead of throwing', async () => {
    await writeFile(join(journalDirOf(), ADMINS_FILE_NAME), '{ this is not json', 'utf8')
    const cell = createTokenCell()

    const message = await executeEffect(
      { kind: 'signin', token: 'mcpa_whatever' },
      depsOf(recordingDispatch().fn, cell),
    )

    const result = message?.kind === 'signin-result' ? message.result : undefined
    expect(result?.kind).toBe('unreadable')
    expect(result?.kind === 'unreadable' ? result.detail : '').not.toBe('')
    expect(cell.get()).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// refresh-services
// ---------------------------------------------------------------------------

describe('executeEffect — refresh-services', () => {
  test('the status document the manager prints is parsed into the header summaries', async () => {
    const { cell, token } = await signedInCell()
    const dispatch = recordingDispatch((io) => {
      io.stdout.write(statusJson(STATUSES))
      return 0
    })

    const message = await executeEffect({ kind: 'refresh-services' }, depsOf(dispatch.fn, cell))

    expect(dispatch.calls[0]?.argv).toEqual(['status', '--json'])
    expect(dispatch.calls[0]?.opts?.services?.env?.[ADMIN_TOKEN_ENV_VAR]).toBe(token)
    expect(message).toEqual({
      kind: 'services',
      statuses: [
        { service: 'ui', state: 'running', host: '127.0.0.1', port: 8091 },
        { service: 'serve', state: 'stopped', host: '127.0.0.1', port: 8090 },
      ],
    })
  })

  test('the document is read whatever the exit code: `status` exits 1 while a service is down', async () => {
    const { cell } = await signedInCell()
    const dispatch = recordingDispatch((io) => {
      io.stdout.write(statusJson(STATUSES))
      return 1
    })

    const message = await executeEffect({ kind: 'refresh-services' }, depsOf(dispatch.fn, cell))

    expect(message).toEqual({
      kind: 'services',
      statuses: [
        { service: 'ui', state: 'running', host: '127.0.0.1', port: 8091 },
        { service: 'serve', state: 'stopped', host: '127.0.0.1', port: 8090 },
      ],
    })
  })

  test('a document that cannot be read leaves the header without services', async () => {
    const { cell } = await signedInCell()
    const dispatch = recordingDispatch((io) => {
      io.stdout.write('not json at all\n')
      return 0
    })

    const message = await executeEffect({ kind: 'refresh-services' }, depsOf(dispatch.fn, cell))

    expect(message).toEqual({ kind: 'services', statuses: undefined })
  })

  test('a failed status call is not a lost session', async () => {
    const { cell } = await signedInCell()
    const dispatch = recordingDispatch((io) => {
      io.stderr.write('no install config\n')
      return 1
    })

    const message = await executeEffect({ kind: 'refresh-services' }, depsOf(dispatch.fn, cell))

    expect(message).toEqual({ kind: 'services', statuses: undefined })
    expect(cell.get()).toBeDefined()
  })

  test('a status call that throws is swallowed into an unknown header', async () => {
    const { cell } = await signedInCell()
    const dispatch = recordingDispatch(() => {
      throw new Error('manager exploded')
    })

    const message = await executeEffect({ kind: 'refresh-services' }, depsOf(dispatch.fn, cell))

    expect(message).toEqual({ kind: 'services', statuses: undefined })
  })

  test("without a session the status is still asked, with the console's own environment on the seams", async () => {
    // `status` needs no token — it reads pid files and probes ports — and the
    // sign-in screen asks for it precisely so it can say "services are down"
    // to somebody who has not signed in yet (plan P3).
    const dispatch = recordingDispatch((io) => {
      io.stdout.write(statusJson(STATUSES))
      return 1
    })

    const message = await executeEffect(
      { kind: 'refresh-services' },
      depsOf(dispatch.fn, createTokenCell()),
    )

    const call = dispatch.calls[0]
    expect(call?.argv).toEqual(['status', '--json'])
    expect(call?.opts?.services?.env).toEqual(OTHER_ENV)
    expect(call?.opts?.services?.env?.[ADMIN_TOKEN_ENV_VAR]).toBeUndefined()
    expect(message).toEqual({
      kind: 'services',
      statuses: [
        { service: 'ui', state: 'running', host: '127.0.0.1', port: 8091 },
        { service: 'serve', state: 'stopped', host: '127.0.0.1', port: 8090 },
      ],
    })
  })

  test('an MCP_ADMIN_TOKEN inherited from the shell is not handed to the pre-sign-in status', async () => {
    // The console is a place an operator signs in AT; a token exported in the
    // shell it was started from is not the session, and a probe that carried
    // it would act as whoever that token names before anybody signed in.
    const dispatch = recordingDispatch((io) => {
      io.stdout.write(statusJson(STATUSES))
      return 1
    })
    const env: NodeJS.ProcessEnv = { ...OTHER_ENV, [ADMIN_TOKEN_ENV_VAR]: 'mcpa_from_the_shell' }

    await executeEffect(
      { kind: 'refresh-services' },
      { ...depsOf(dispatch.fn, createTokenCell()), env },
    )

    const call = dispatch.calls[0]
    for (const seam of SESSION_ENV_SEAMS) {
      expect(call?.opts?.[seam]?.env?.[ADMIN_TOKEN_ENV_VAR], seam).toBeUndefined()
    }
    // …and everything else the operator exported still reaches the command.
    expect(call?.opts?.services?.env?.['PATH']).toBe(OTHER_ENV['PATH'])
  })

  test('a status call without a session that throws still leaves the header unknown', async () => {
    const dispatch = recordingDispatch(() => {
      throw new Error('no install config')
    })

    const message = await executeEffect(
      { kind: 'refresh-services' },
      depsOf(dispatch.fn, createTokenCell()),
    )

    expect(message).toEqual({ kind: 'services', statuses: undefined })
  })
})

// ---------------------------------------------------------------------------
// poll — the quiet re-read behind the Approvals timer (mcpcut phase 5)
// ---------------------------------------------------------------------------

/** The `Msg` a poll answered with, or a failure naming what came back instead. */
function pollResultOf(message: Msg | undefined): Extract<Msg, { kind: 'poll-result' }> {
  if (message?.kind !== 'poll-result') {
    throw new Error(`expected a poll-result, got ${message?.kind}`)
  }
  return message
}

const POLL_REQUEST: RunRequest = {
  actionId: 'list',
  argv: ['approvals', 'list'],
  display: ['approvals', 'list'],
}

describe('executeEffect — poll', () => {
  test('answers with a poll-result carrying the output, the token on the seams and none in argv', async () => {
    const { cell, token } = await signedInCell()
    const dispatch = recordingDispatch((io) => {
      io.stdout.write('no pending requests\n')
      return 0
    })

    const message = await executeEffect(
      { kind: 'poll', request: POLL_REQUEST },
      depsOf(dispatch.fn, cell),
    )

    const call = dispatch.calls[0]
    expect(call?.argv).toEqual(['approvals', 'list'])
    expect(call?.opts?.approvals?.env?.[ADMIN_TOKEN_ENV_VAR]).toBe(token)
    expect(call?.argv.includes(token)).toBe(false)
    expect(pollResultOf(message).result).toEqual({
      argv: POLL_REQUEST.argv,
      display: POLL_REQUEST.display,
      exitCode: 0,
      stdout: 'no pending requests\n',
      stderr: '',
    })
  })

  test('the exit code of a refusal is folded in as it came back', async () => {
    const { cell } = await signedInCell()
    const dispatch = recordingDispatch((io) => {
      io.stderr.write('forbidden\n')
      return 3
    })

    const message = await executeEffect(
      { kind: 'poll', request: POLL_REQUEST },
      depsOf(dispatch.fn, cell),
    )

    expect(pollResultOf(message).result).toMatchObject({ exitCode: 3, stderr: 'forbidden\n' })
  })

  test('an empty session cell is a lost session, and nothing is dispatched', async () => {
    const dispatch = recordingDispatch()

    const message = await executeEffect(
      { kind: 'poll', request: POLL_REQUEST },
      depsOf(dispatch.fn, createTokenCell()),
    )

    expect(message).toEqual({ kind: 'session-lost' })
    expect(dispatch.calls).toHaveLength(0)
  })

  test('a session rotated from a shell ends the console, quiet poll or not', async () => {
    const { cell } = await signedInCell()
    await createAdminStore({ journalDir: journalDirOf() }).rotateAdmin(ADMIN_NAME)
    const dispatch = recordingDispatch()

    const message = await executeEffect(
      { kind: 'poll', request: POLL_REQUEST },
      depsOf(dispatch.fn, cell),
    )

    expect(message).toEqual({ kind: 'session-lost' })
    expect(cell.get()).toBeUndefined()
    expect(dispatch.calls).toHaveLength(0)
  })

  test('a dispatch that throws is a failed poll result, not a crashed console', async () => {
    const { cell } = await signedInCell()
    const dispatch = recordingDispatch(() => {
      throw new Error('the store is locked')
    })

    const message = await executeEffect(
      { kind: 'poll', request: POLL_REQUEST },
      depsOf(dispatch.fn, cell),
    )

    const { result } = pollResultOf(message)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('the store is locked')
  })
})

// ---------------------------------------------------------------------------
// reopen — the console stepping aside for a child on the same terminal
// ---------------------------------------------------------------------------

describe('executeEffect — reopen', () => {
  test('writes the argv into the cell and answers with nothing to fold', async () => {
    const reopen = createReopenCell()
    const dispatch = recordingDispatch()
    const deps: EffectDeps = { ...depsOf(dispatch.fn, createTokenCell()), reopen }

    const message = await executeEffect({ kind: 'reopen', argv: ['setup'] }, deps)

    expect(message).toBeUndefined()
    expect(reopen.get()).toEqual(['setup'])
    // Nothing is run from here: the runtime ends the console and the CLI
    // spawns this argv once the terminal has been given back.
    expect(dispatch.calls).toHaveLength(0)
  })

  test('the cell holds a copy: the argv outlives the effect it came on', async () => {
    // Both writers of this cell copy (`runtime.ts` honours a reopen in
    // `enqueue`, this module when an effect is executed directly), so the
    // array the caller spawns from cannot be the one a later step rewrote.
    const reopen = createReopenCell()
    const argv = ['setup']
    const deps: EffectDeps = { ...depsOf(recordingDispatch().fn, createTokenCell()), reopen }

    await executeEffect({ kind: 'reopen', argv }, deps)

    expect(reopen.get()).toEqual(argv)
    expect(reopen.get()).not.toBe(argv)
  })

  test('a runtime with no reopen seam is not a crash', async () => {
    const message = await executeEffect(
      { kind: 'reopen', argv: ['setup'] },
      depsOf(recordingDispatch().fn, createTokenCell()),
    )

    expect(message).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// wizard-run and wizard-finish
// ---------------------------------------------------------------------------

/** One rung of the deploy ladder; `setup` is the rung that mints the first admin. */
const WIZARD_REQUEST: RunRequest = {
  actionId: 'setup',
  argv: ['setup', '--yes', '--data-dir', '/var/lib/x'],
  display: ['setup', '--yes', '--data-dir', '/var/lib/x'],
}

/** The `Msg` a rung answered with, or a failure naming what came back instead. */
function wizardResultOf(message: Msg | undefined): Extract<Msg, { kind: 'wizard-run-result' }> {
  if (message?.kind !== 'wizard-run-result') {
    throw new Error(`expected a wizard-run-result, got ${message?.kind}`)
  }
  return message
}

describe('executeEffect — wizard-run', () => {
  test("dispatches the step's argv with the console's own environment on the seams", async () => {
    const cell = createTokenCell()
    const dispatch = recordingDispatch((io) => {
      io.stdout.write('admin: owner\n')
      return 0
    })
    const deps = depsOf(dispatch.fn, cell)

    const message = await executeEffect(
      { kind: 'wizard-run', step: 'setup', request: WIZARD_REQUEST },
      deps,
    )

    const call = dispatch.calls[0]
    expect(call?.argv).toEqual(['setup', '--yes', '--data-dir', '/var/lib/x'])
    // Everything the operator exported reaches the rung — but not by identity:
    // the console strips `MCP_ADMIN_TOKEN` from every no-session dispatch, so
    // the object handed down is a copy without it.
    expect(call?.opts?.setup?.env).toEqual(withoutAdminToken(deps.env))
    expect(call?.opts?.services?.env).toEqual(withoutAdminToken(deps.env))
    expect(message).toEqual({
      kind: 'wizard-run-result',
      step: 'setup',
      result: {
        argv: WIZARD_REQUEST.argv,
        display: WIZARD_REQUEST.display,
        exitCode: 0,
        stdout: 'admin: owner\n',
        stderr: '',
      },
    })
  })

  test('runs with an empty session cell: there is no admin to resolve yet', async () => {
    const cell = createTokenCell()
    const dispatch = recordingDispatch()

    const message = await executeEffect(
      { kind: 'wizard-run', step: 'start-ui', request: WIZARD_REQUEST },
      depsOf(dispatch.fn, cell),
    )

    expect(dispatch.calls).toHaveLength(1)
    expect(dispatch.calls[0]?.opts?.setup?.env?.[ADMIN_TOKEN_ENV_VAR]).toBeUndefined()
    expect(cell.get()).toBeUndefined()
    expect(wizardResultOf(message).step).toBe('start-ui')
  })

  test('an MCP_ADMIN_TOKEN inherited from the shell reaches no rung of the ladder', async () => {
    // The wizard builds the install that will have admins; it has none yet, so
    // nothing it runs may act as whoever a token left in the shell names. The
    // pre-sign-in `status` is held to the same rule two describes above.
    const dispatch = recordingDispatch()
    const env: NodeJS.ProcessEnv = { ...OTHER_ENV, [ADMIN_TOKEN_ENV_VAR]: 'mcpa_from_the_shell' }

    await executeEffect(
      { kind: 'wizard-run', step: 'setup', request: WIZARD_REQUEST },
      { ...depsOf(dispatch.fn, createTokenCell()), env },
    )

    const call = dispatch.calls[0]
    for (const seam of SESSION_ENV_SEAMS) {
      expect(call?.opts?.[seam]?.env?.[ADMIN_TOKEN_ENV_VAR], seam).toBeUndefined()
    }
    // …and everything else the operator exported still reaches the rung.
    expect(call?.opts?.setup?.env?.['PATH']).toBe(OTHER_ENV['PATH'])
  })

  test('a command that throws becomes a failed rung, not a crashed wizard', async () => {
    const dispatch = recordingDispatch((io) => {
      io.stdout.write('check  data dir\n')
      throw new Error('the port is taken')
    })

    const message = await executeEffect(
      { kind: 'wizard-run', step: 'setup', request: WIZARD_REQUEST },
      depsOf(dispatch.fn, createTokenCell()),
    )

    const { result } = wizardResultOf(message)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('check  data dir\n')
    expect(result.stderr).toContain('the port is taken')
  })

  test('a rung that prints more than the console keeps is cut, and the pane says so', async () => {
    const dispatch = recordingDispatch((io) => {
      io.stdout.write('x'.repeat(OUTPUT_MAX_CHARS + 1))
      return 0
    })

    const message = await executeEffect(
      { kind: 'wizard-run', step: 'setup', request: WIZARD_REQUEST },
      depsOf(dispatch.fn, createTokenCell()),
    )

    expect(wizardResultOf(message).result.stderr).toContain(OUTPUT_CUT_NOTE)
  })

  test('the exit code of a refusal is reported as it came back', async () => {
    const dispatch = recordingDispatch((io) => {
      io.stderr.write('config already exists\n')
      return 2
    })

    const message = await executeEffect(
      { kind: 'wizard-run', step: 'setup', request: WIZARD_REQUEST },
      depsOf(dispatch.fn, createTokenCell()),
    )

    expect(wizardResultOf(message).result).toMatchObject({
      exitCode: 2,
      stderr: 'config already exists\n',
    })
  })
})

describe('createWizardOutcomeCell', () => {
  test('starts empty, holds what it is given, and can be emptied again', () => {
    const cell = createWizardOutcomeCell()

    expect(cell.get()).toBeUndefined()

    cell.set('sign-in')
    expect(cell.get()).toBe('sign-in')

    cell.set(undefined)
    expect(cell.get()).toBeUndefined()
  })
})

describe('executeEffect — wizard-finish', () => {
  test('records the outcome the runtime reopens the console for', async () => {
    const outcome = createWizardOutcomeCell()
    const dispatch = recordingDispatch()
    const deps: EffectDeps = { ...depsOf(dispatch.fn, createTokenCell()), wizard: { outcome } }

    const message = await executeEffect({ kind: 'wizard-finish' }, deps)

    expect(message).toBeUndefined()
    expect(outcome.get()).toBe('sign-in')
    expect(dispatch.calls).toHaveLength(0)
  })

  test('a runtime with no wizard seam is not a crash', async () => {
    const message = await executeEffect(
      { kind: 'wizard-finish' },
      depsOf(recordingDispatch().fn, createTokenCell()),
    )

    expect(message).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// quit
// ---------------------------------------------------------------------------

describe('executeEffect — quit', () => {
  test('leaves the runtime to end the session', async () => {
    const dispatch = recordingDispatch()
    const effect: Effect = { kind: 'quit', exitCode: 0 }

    const message = await executeEffect(effect, depsOf(dispatch.fn, createTokenCell()))

    expect(message).toBeUndefined()
    expect(dispatch.calls).toHaveLength(0)
  })
})

describe('executeEffect — what the reviews asked for', () => {
  test('a header refresh after the admin was rotated ends the session', async () => {
    const { cell } = await signedInCell()
    await createAdminStore({ journalDir: journalDirOf() }).rotateAdmin(ADMIN_NAME)
    const dispatch = recordingDispatch()

    const message = await executeEffect({ kind: 'refresh-services' }, depsOf(dispatch.fn, cell))

    expect(message).toEqual({ kind: 'session-lost' })
    expect(cell.get()).toBeUndefined()
    expect(dispatch.calls).toHaveLength(0)
  })

  test('a store that cannot be opened at all is a notice on the sign-in screen, not a crash', async () => {
    const notADir = join(journalDirOf(), 'file-not-dir')
    await writeFile(notADir, '')
    const cell = createTokenCell()
    const deps: EffectDeps = { ...depsOf(recordingDispatch().fn, cell), journalDir: notADir }

    const message = await executeEffect({ kind: 'signin', token: 'mcpa_whatever' }, deps)

    expect(message?.kind).toBe('signin-result')
    expect(message?.kind === 'signin-result' && message.result.kind).toBe('unreadable')
    expect(cell.get()).toBeUndefined()
  })

  test('a run that prints more than the console keeps is cut, and the pane says so', async () => {
    const { cell } = await signedInCell()
    const dispatch = recordingDispatch((io) => {
      io.stdout.write('x'.repeat(OUTPUT_MAX_CHARS + 1))
      return 0
    })

    const result = runResultOf(
      await executeEffect({ kind: 'run', request: RUN_REQUEST }, depsOf(dispatch.fn, cell)),
    )

    expect(result.result.stdout).toBe('')
    expect(result.result.stderr).toContain(OUTPUT_CUT_NOTE)
  })
})
