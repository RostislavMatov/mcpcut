import type { WriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMINS_FILE_NAME, ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import type { CliIo, DispatchFn, DispatchOptions } from '../../src/cli/dispatch-types.js'
import { statusJson } from '../../src/services/format.js'
import type { ServiceStatus } from '../../src/services/manager-types.js'
import { OUTPUT_CUT_NOTE, OUTPUT_MAX_CHARS, savedToLine } from '../../src/tui/constants.js'
import type { Effect, Msg, RunRequest } from '../../src/tui/model.js'
import {
  exclusiveStream,
  type SinkStreamFactory,
  type SinkWritable,
} from '../../src/tui/run-sink.js'
import {
  createTokenCell,
  createWizardOutcomeCell,
  executeEffect,
  type EffectDeps,
  type TokenCell,
} from '../../src/tui/runtime-effects.js'
import { SESSION_ENV_SEAMS } from '../../src/tui/session-env.js'

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
 * The store is real and lives in a temp journal directory, the way
 * `tests/cli/admin-cmd.test.ts` builds one — the freshness check is exactly
 * the store lookup the web UI does, and a fake would prove nothing about it.
 */

const ADMIN_NAME = 'alice'
const OTHER_ENV: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
const STATUSES: readonly ServiceStatus[] = [
  { service: 'ui', state: 'running', host: '127.0.0.1', port: 8091, pid: 4321, logPath: '/logs/ui.log' },
  { service: 'serve', state: 'stopped', host: '127.0.0.1', port: 8090, logPath: '/logs/serve.log' },
]

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-runtime-effects-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface DispatchCall {
  readonly argv: readonly string[]
  readonly opts: DispatchOptions | undefined
}

interface RecordingDispatch {
  readonly fn: DispatchFn
  readonly calls: readonly DispatchCall[]
}

/** What a fake `dispatch` does with the io it is handed, before it answers. */
type DispatchBehaviour = (io: CliIo) => number | Promise<number>

/** A `dispatch` that remembers how it was called and answers as told. */
function recordingDispatch(behaviour: DispatchBehaviour = () => 0): RecordingDispatch {
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
function baseOptions(): DispatchOptions {
  return { journalDir, admin: { journalDir } }
}

function depsOf(dispatch: DispatchFn, token: TokenCell): EffectDeps {
  return { dispatch, dispatchOptions: baseOptions(), env: OTHER_ENV, journalDir, token }
}

/** An admin in the temp store, with the one-time token the console signs in with. */
async function createTestAdmin(): Promise<string> {
  const store = createAdminStore({ journalDir })
  const created = await store.createAdmin(ADMIN_NAME, 'owner')
  return created.token
}

/** A signed-in cell: the token is in it because `signin` put it there. */
async function signedInCell(): Promise<{ cell: TokenCell; token: string }> {
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

const RUN_REQUEST: RunRequest = {
  actionId: 'admin.list',
  argv: ['admin', 'list'],
  display: ['admin', 'list'],
}

/**
 * The request `JOURNAL_SECTION`'s `export` really builds: the path is NOT in
 * argv (the command has no `--out` of its own — that flag belongs to `export
 * --report`), it is the `stdoutToField` the runtime opens the file from.
 */
function exportRequest(stdoutPath: string): RunRequest {
  return {
    actionId: 'journal.export',
    argv: ['export'],
    display: ['export'],
    stdoutPath,
  }
}

/** The `Msg` a run answered with, or a failure naming what came back instead. */
function runResultOf(message: Msg | undefined): Extract<Msg, { kind: 'run-result' }> {
  if (message?.kind !== 'run-result') throw new Error(`expected a run-result, got ${message?.kind}`)
  return message
}

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
    await writeFile(join(journalDir, ADMINS_FILE_NAME), '{ this is not json', 'utf8')
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
    await createAdminStore({ journalDir }).rotateAdmin(ADMIN_NAME)

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

  test('without a session there is nothing to ask, and nothing is dispatched', async () => {
    const dispatch = recordingDispatch()

    const message = await executeEffect(
      { kind: 'refresh-services' },
      depsOf(dispatch.fn, createTokenCell()),
    )

    expect(message).toEqual({ kind: 'services', statuses: undefined })
    expect(dispatch.calls).toHaveLength(0)
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
    expect(call?.opts?.setup?.env).toBe(deps.env)
    expect(call?.opts?.services?.env).toBe(deps.env)
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
    await createAdminStore({ journalDir }).rotateAdmin(ADMIN_NAME)
    const dispatch = recordingDispatch()

    const message = await executeEffect({ kind: 'refresh-services' }, depsOf(dispatch.fn, cell))

    expect(message).toEqual({ kind: 'session-lost' })
    expect(cell.get()).toBeUndefined()
    expect(dispatch.calls).toHaveLength(0)
  })

  test('a store that cannot be opened at all is a notice on the sign-in screen, not a crash', async () => {
    const notADir = join(journalDir, 'file-not-dir')
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

describe('executeEffect — run writing stdout to a file', () => {
  const LINES = '{"a":1}\n{"b":2}\n{"c":3}\n'

  test('the file holds what the command printed, at 0600, and the pane holds the receipt', async () => {
    const { cell } = await signedInCell()
    const path = join(journalDir, 'export.jsonl')
    const dispatch = recordingDispatch((io) => {
      io.stdout.write('{"a":1}\n')
      io.stdout.write('{"b":2}\n')
      io.stdout.write('{"c":3}\n')
      io.stderr.write('legacy records not imported\n')
      return 0
    })

    const message = await executeEffect(
      { kind: 'run', request: exportRequest(path) },
      depsOf(dispatch.fn, cell),
    )

    expect(await readFile(path, 'utf8')).toBe(LINES)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const { result } = runResultOf(message)
    expect(result.stdout).toBe(savedToLine(path, Buffer.byteLength(LINES)))
    expect(result.stderr).toBe('legacy records not imported\n')
    expect(result.exitCode).toBe(0)
  })

  test('a path that is already taken is a failed run, and nothing is dispatched', async () => {
    const { cell } = await signedInCell()
    const path = join(journalDir, 'taken.jsonl')
    await writeFile(path, 'do not truncate me', 'utf8')
    const dispatch = recordingDispatch()

    const message = await executeEffect(
      { kind: 'run', request: exportRequest(path) },
      depsOf(dispatch.fn, cell),
    )

    const { result } = runResultOf(message)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('EEXIST')
    expect(result.stdout).toBe('')
    expect(dispatch.calls).toHaveLength(0)
    expect(await readFile(path, 'utf8')).toBe('do not truncate me')
  })

  test('a directory that does not exist is a failed run, and nothing is dispatched', async () => {
    const { cell } = await signedInCell()
    const dispatch = recordingDispatch()

    const message = await executeEffect(
      { kind: 'run', request: exportRequest(join(journalDir, 'nowhere', 'export.jsonl')) },
      depsOf(dispatch.fn, cell),
    )

    const { result } = runResultOf(message)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('ENOENT')
    expect(dispatch.calls).toHaveLength(0)
  })

  test('a command that throws still leaves the file closed with what it had written', async () => {
    const { cell } = await signedInCell()
    const path = join(journalDir, 'partial.jsonl')
    const dispatch = recordingDispatch((io) => {
      io.stdout.write('{"a":1}\n')
      throw new Error('the journal is on fire')
    })

    const message = await executeEffect(
      { kind: 'run', request: exportRequest(path) },
      depsOf(dispatch.fn, cell),
    )

    const { result } = runResultOf(message)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('the journal is on fire')
    expect(await readFile(path, 'utf8')).toBe('{"a":1}\n')
    expect(result.stdout).toBe(savedToLine(path, 8))
  })
})

/**
 * The deadlock a file sink used to be able to reach (phase 4 review, H1). A
 * command parks on `once('drain')` the moment a write is refused; a stream
 * that has errored emits no `'drain'` ever again, so the run never answered,
 * `executeEffect` never resolved, and the console stayed `busy` and deaf.
 * What matters here is that the effect ANSWERS — with the failure, as a run
 * that went wrong, rather than not at all.
 */
describe('executeEffect — a write failure under a parked command', () => {
  /** A chunk past the 64 KiB high-water mark of a file stream, so `write` refuses it. */
  const PAST_HIGH_WATER_MARK = `${'x'.repeat(256 * 1024)}\n`

  /** Long enough for a real drain, short enough that a deadlock is not a five-second wait. */
  const SETTLE_TIMEOUT_MS = 2_000

  const WRITE_FAILURE = 'ENOSPC-like: no space left on device'

  function settled<T>(promise: Promise<T>, what: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`${what} never settled`)), SETTLE_TIMEOUT_MS).unref()
      }),
    ])
  }

  /** Opens the production way, and hands the test the stream it opened. */
  function capturingStream(captured: { stream?: WriteStream }): SinkStreamFactory {
    return (path: string) => {
      const stream = exclusiveStream(path)
      captured.stream = stream
      return stream
    }
  }

  test('the run answers with the failure instead of parking the console for ever', async () => {
    // Arrange
    const { cell } = await signedInCell()
    const path = join(journalDir, 'export.jsonl')
    const captured: { stream?: WriteStream } = {}
    const dispatch = recordingDispatch(async (io) => {
      const stdout = io.stdout as SinkWritable
      if (stdout.write(PAST_HIGH_WATER_MARK) === false) {
        const parked = new Promise<void>((resolve) => {
          stdout.once?.('drain', resolve)
        })
        captured.stream?.destroy(new Error(WRITE_FAILURE))
        await parked
      }
      return 0
    })

    // Act
    const message = await settled(
      executeEffect(
        { kind: 'run', request: exportRequest(path) },
        { ...depsOf(dispatch.fn, cell), openStream: capturingStream(captured) },
      ),
      'the run',
    )

    // Assert
    const { result } = runResultOf(message)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(WRITE_FAILURE)
    // And the pane must not tell the operator the export is on disk.
    expect(result.stdout).toContain('before failing')
  })
})
