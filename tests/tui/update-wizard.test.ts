import { describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_PREFIX } from '../../src/admin/constants.js'
import { DEFAULT_SERVE_HOST, DEFAULT_SERVE_PORT } from '../../src/cli/serve-constants.js'
import { BOOTSTRAP_ADMIN_NAME, DEFAULT_UI_HOST, DEFAULT_UI_PORT } from '../../src/cli/ui-constants.js'
import { START_READY_TIMEOUT_MS } from '../../src/services/constants.js'
import { SUPERVISORS } from '../../src/setup/constants.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfig } from '../../src/setup/schema.js'
import {
  DEPLOY_EXTERNAL_DETAIL,
  DEPLOY_SETUP_DONE_DETAIL,
  DEPLOY_SETUP_DONE_WITH_OWNER_DETAIL,
  DEPLOY_TOKEN_PLACEHOLDER,
  deployExitDetail,
  deployWaitingDetail,
  EXIT_OK,
  wizardFailedNotice,
} from '../../src/tui/constants.js'
import { valuesOf } from '../../src/tui/form.js'
import type { KeyEvent, NamedKey } from '../../src/tui/keys.js'
import type {
  DeployStepId,
  Model,
  Msg,
  TerminalSize,
  WizardScreen,
  WizardStage,
} from '../../src/tui/model.js'
import type { RunResult } from '../../src/tui/output.js'
import { update } from '../../src/tui/update.js'
import { wizardScreenOf, type WizardPrefill } from '../../src/tui/wizard-fields.js'

/**
 * The wizard's reducer (mcpcut phase 3, Task 3): five stages, three rungs and
 * one chain of effects, all of it a pure `(model, msg) → step`. Every case
 * goes through `update` rather than `updateWizard` directly, so the route
 * `update.ts` takes and the interrupt key it answers first are asserted here
 * too.
 *
 * The deploy chain is driven the way the runtime drives it: a key opens it, a
 * `wizard-run-result` closes one rung and the step it returns carries the
 * effect that opens the next. Nothing here dispatches anything.
 */

const SIZE: TerminalSize = { columns: 80, rows: 24 }
const DATA_DIR = '/var/lib/x'
const CONFIG_PATH = '/home/op/.mcpcut/config.json'

/** What `setup` prints when it minted the first admin, and when it did not. */
const SETUP_STDOUT = `admin: ${BOOTSTRAP_ADMIN_NAME}\nrole: owner\ntoken: mcpa_x\n`
const SETUP_STDOUT_NO_TOKEN = 'admin: 1 admin(s) exist, none created\n'
const START_UI_STDOUT = 'ui:    started pid 1 on http://127.0.0.1:8091/ (log /var/lib/x/run/ui.log)\n'
const START_SERVE_STDOUT = 'serve: started pid 2 on http://127.0.0.1:8090/\n'

const MINTED_ADMIN = { name: BOOTSTRAP_ADMIN_NAME, token: 'mcpa_x' }

const SETUP_ARGV: readonly string[] = [
  'setup',
  '--yes',
  '--data-dir',
  DATA_DIR,
  '--ui-host',
  DEFAULT_UI_HOST,
  '--ui-port',
  String(DEFAULT_UI_PORT),
  '--serve-host',
  DEFAULT_SERVE_HOST,
  '--serve-port',
  String(DEFAULT_SERVE_PORT),
  '--no-behind-tls',
  '--admin',
  BOOTSTRAP_ADMIN_NAME,
  '--supervisor',
  SUPERVISORS[0],
]

function key(kind: NamedKey): Msg {
  return { kind: 'key', key: { kind } as KeyEvent }
}

function char(value: string): Msg {
  return { kind: 'key', key: { kind: 'char', char: value } }
}

function ctrl(value: string): Msg {
  return { kind: 'key', key: { kind: 'ctrl', char: value } }
}

function typed(model: Model, text: string): Model {
  return [...text].reduce((current, letter) => update(current, char(letter)).model, model)
}

function prefillOf(config: InstallConfig = defaultInstallConfig(DATA_DIR)): WizardPrefill {
  return { mode: 'first-run', configPath: CONFIG_PATH, config }
}

function wizardModel(config?: InstallConfig): Model {
  return { screen: wizardScreenOf(prefillOf(config)), size: SIZE }
}

/** The same install, bound where the network can reach it. */
function exposedConfig(): InstallConfig {
  const config = defaultInstallConfig(DATA_DIR)
  return { ...config, ui: { ...config.ui, host: '0.0.0.0' } }
}

function externalConfig(): InstallConfig {
  return { ...defaultInstallConfig(DATA_DIR), supervisor: 'external' }
}

function wizardOf(model: Model): WizardScreen {
  if (model.screen.kind !== 'wizard') throw new Error(`expected a wizard, got ${model.screen.kind}`)

  return model.screen
}

function stageOf(model: Model): WizardStage {
  return wizardOf(model).stage
}

function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return { argv: ['setup'], display: ['setup'], exitCode: 0, stdout: '', stderr: '', ...overrides }
}

/** A finished rung, with the command line the runtime would have dispatched. */
function resultMsg(step: DeployStepId, overrides: Partial<RunResult> = {}): Msg {
  const argv = step === 'setup' ? SETUP_ARGV : ['start', step === 'start-ui' ? 'ui' : 'serve']

  return { kind: 'wizard-run-result', step, result: runResult({ argv, display: argv, ...overrides }) }
}

/** A token of the shape the admin store mints, unlike the short one of the fixtures. */
const SECRET = `${ADMIN_TOKEN_PREFIX}${'z'.repeat(43)}`

/** The transcript the stage on screen shows, as one string. */
function transcriptOf(model: Model): string {
  const stage = stageOf(model)
  if (stage.kind === 'deploying') return (stage.output?.lines ?? []).join('\n')
  if (stage.kind === 'setup-failed') return stage.output.lines.join('\n')

  throw new Error(`stage ${stage.kind} has no transcript`)
}

/** Where the transcript of the stage the model is on has been scrolled to. */
function scrollOf(model: Model): number {
  const stage = stageOf(model)
  if (stage.kind === 'deploying') return stage.output?.scroll ?? 0
  if (stage.kind === 'setup-failed') return stage.output.scroll

  throw new Error(`stage ${stage.kind} has no transcript`)
}

/** Stdout long enough that the transcript has somewhere to scroll. */
function longStdout(lineCount: number): string {
  return `${Array.from({ length: lineCount }, (_, index) => `line ${index}`).join('\n')}\n`
}

/** A wizard mid-deploy: the form was submitted and `setup` is in flight. */
function deployingModel(config?: InstallConfig): Model {
  return update(wizardModel(config), key('enter')).model
}

/** A wizard that finished `setup` and is waiting on `start ui`. */
function afterSetupModel(overrides: Partial<RunResult> = {}): Model {
  return update(deployingModel(), resultMsg('setup', { stdout: SETUP_STDOUT, ...overrides })).model
}

/** A wizard on its final screen, with or without a token to show. */
function doneModel(stdout: string = SETUP_STDOUT): Model {
  const started = update(deployingModel(), resultMsg('setup', { stdout })).model
  const ui = update(started, resultMsg('start-ui', { stdout: START_UI_STDOUT })).model

  return update(ui, resultMsg('start-serve', { stdout: START_SERVE_STDOUT })).model
}

/**
 * A deep copy that keeps functions by reference: the form carries field
 * validators, which `structuredClone` refuses outright.
 */
function snapshotOf<T>(value: T): T {
  if (Array.isArray(value)) return value.map(snapshotOf) as unknown as T
  if (value === null || typeof value !== 'object') return value

  return Object.fromEntries(Object.entries(value).map(([name, each]) => [name, snapshotOf(each)])) as T
}

/** Freezing turns any in-place write into a `TypeError` under strict mode. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const each of Object.values(value)) deepFreeze(each)

  return Object.freeze(value)
}

describe('updateWizard: the form', () => {
  test('a printable character reaches the focused field', () => {
    const model = typed(wizardModel(), 'y')

    expect(valuesOf(wizardOf(model).form).dataDir).toBe(`${DATA_DIR}y`)
  })

  test('Tab moves the focus on and Shift-Tab moves it back', () => {
    const forward = update(wizardModel(), key('tab'))
    expect(wizardOf(forward.model).form.focus).toBe(1)

    const back = update(forward.model, key('backtab'))
    expect(wizardOf(back.model).form.focus).toBe(0)
  })

  test('a key the form has no use for leaves the very same model', () => {
    const model = wizardModel()

    const step = update(model, key('left'))

    expect(step.model).toBe(model)
    expect(step.effects).toEqual([])
  })

  test('Escape leaves the wizard with code 0', () => {
    const step = update(wizardModel(), key('escape'))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
  })

  test('q on the form is a letter, not a way out', () => {
    const step = update(wizardModel(), char('q'))

    expect(step.effects).toEqual([])
    expect(valuesOf(wizardOf(step.model).form).dataDir).toBe(`${DATA_DIR}q`)
  })

  test('an invalid port keeps the form and asks for nothing', () => {
    const focused = update(update(wizardModel(), key('tab')).model, key('tab')).model
    const cleared = [...String(DEFAULT_UI_PORT)].reduce(
      (current) => update(current, key('backspace')).model,
      focused,
    )

    const step = update(typed(cleared, 'abc'), key('enter'))

    expect(stageOf(step.model).kind).toBe('form')
    expect(step.effects).toEqual([])
    const port = wizardOf(step.model).form.fields.find((field) => field.spec.name === 'uiPort')
    expect(port?.error).toBeDefined()
  })

  test('Enter on a loopback install deploys at once', () => {
    const step = update(wizardModel(), key('enter'))

    expect(step.effects).toEqual([
      {
        kind: 'wizard-run',
        step: 'setup',
        request: { actionId: 'setup', argv: SETUP_ARGV, display: SETUP_ARGV },
      },
    ])
    const stage = stageOf(step.model)
    expect(stage.kind).toBe('deploying')
    expect(stage.kind === 'deploying' && stage.steps.map((each) => each.state)).toEqual([
      'running',
      'pending',
      'pending',
    ])
  })

  test('editing a field clears the notice a failed deploy left', () => {
    const failed = update(deployingModel(), resultMsg('setup', { exitCode: 1 })).model
    const back = update(failed, key('enter')).model
    expect(stageOf(back)).toEqual({ kind: 'form', notice: wizardFailedNotice(1) })

    const edited = typed(back, 'z')

    expect(stageOf(edited)).toEqual({ kind: 'form' })
  })
})

describe('updateWizard: the exposure confirmation', () => {
  test('a bind the network can reach asks before anything is written', () => {
    const step = update(wizardModel(exposedConfig()), key('enter'))

    const stage = stageOf(step.model)
    expect(step.effects).toEqual([])
    expect(stage.kind).toBe('confirm-exposure')
    if (stage.kind !== 'confirm-exposure') throw new Error('expected the confirmation')
    expect(stage.warnings).toHaveLength(1)
    expect(stage.warnings[0]).toContain('ADR-0004')
  })

  test('no takes the operator back to the form, unwritten', () => {
    const asked = update(wizardModel(exposedConfig()), key('enter')).model

    const step = update(asked, char('n'))

    expect(stageOf(step.model)).toEqual({ kind: 'form' })
    expect(step.effects).toEqual([])
  })

  test('yes runs the very command the question was about', () => {
    const asked = update(wizardModel(exposedConfig()), key('enter'))
    const stage = stageOf(asked.model)
    if (stage.kind !== 'confirm-exposure') throw new Error('expected the confirmation')

    const step = update(asked.model, char('y'))

    expect(step.effects).toEqual([{ kind: 'wizard-run', step: 'setup', request: stage.request }])
    expect(stageOf(step.model).kind).toBe('deploying')
  })
})

describe('updateWizard: while a step is in flight', () => {
  test('letters are ignored', () => {
    const model = deployingModel()

    const step = update(model, char('q'))

    expect(step.model).toBe(model)
    expect(step.effects).toEqual([])
  })

  test('Ctrl-C still gets the operator out', () => {
    const step = update(deployingModel(), ctrl('c'))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
  })

  test('the transcript under the ladder scrolls', () => {
    const model = update(
      deployingModel(),
      resultMsg('setup', { stdout: `${SETUP_STDOUT}${longStdout(100)}` }),
    ).model

    const down = update(model, key('pagedown'))
    expect(scrollOf(down.model)).toBeGreaterThan(0)

    const end = update(down.model, key('end'))
    expect(scrollOf(end.model)).toBeGreaterThanOrEqual(scrollOf(down.model))

    const up = update(end.model, key('pageup'))
    expect(scrollOf(up.model)).toBeLessThan(scrollOf(end.model))
  })
})

describe('updateWizard: setup that did not complete', () => {
  test('the rung is marked and the transcript is shown from its end', () => {
    const step = update(
      deployingModel(),
      resultMsg('setup', { exitCode: 1, stdout: longStdout(100) }),
    )

    const stage = stageOf(step.model)
    expect(step.effects).toEqual([])
    expect(stage.kind).toBe('setup-failed')
    if (stage.kind !== 'setup-failed') throw new Error('expected the failed stage')
    expect(stage.steps[0]).toEqual({ id: 'setup', state: 'failed', detail: deployExitDetail(1) })
    expect(stage.steps[1]?.state).toBe('pending')
    expect(stage.output.scroll).toBeGreaterThan(0)
  })

  test('Enter returns to the form with a notice and the SAME values', () => {
    const edited = typed(wizardModel(), 'y')
    const failed = update(update(edited, key('enter')).model, resultMsg('setup', { exitCode: 1 }))

    const step = update(failed.model, key('enter'))

    expect(stageOf(step.model)).toEqual({ kind: 'form', notice: wizardFailedNotice(1) })
    expect(valuesOf(wizardOf(step.model).form).dataDir).toBe(`${DATA_DIR}y`)
    expect(step.effects).toEqual([])
  })

  test.each([['q'], ['escape']])('%s leaves with code 0', (answer) => {
    const failed = update(deployingModel(), resultMsg('setup', { exitCode: 1 })).model

    const step = update(failed, answer === 'escape' ? key('escape') : char(answer))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
  })

  test('a key that neither retries nor scrolls leaves the very same model', () => {
    const failed = update(deployingModel(), resultMsg('setup', { exitCode: 1 })).model

    const step = update(failed, key('down'))

    expect(step.model).toBe(failed)
    expect(step.effects).toEqual([])
  })

  test('the transcript scrolls back up', () => {
    const failed = update(
      deployingModel(),
      resultMsg('setup', { exitCode: 1, stdout: longStdout(100) }),
    ).model

    // The panel opens at its end — where the check that failed is — so the
    // keys that move are the ones that go back.
    const up = update(failed, key('pageup'))
    expect(scrollOf(up.model)).toBeLessThan(scrollOf(failed))

    const start = update(up.model, key('home'))
    expect(scrollOf(start.model)).toBe(0)
  })
})

describe('updateWizard: setup that completed', () => {
  test('the minted admin rides along and the next rung is asked for', () => {
    const step = update(deployingModel(), resultMsg('setup', { stdout: SETUP_STDOUT }))

    const stage = stageOf(step.model)
    expect(stage.kind).toBe('deploying')
    if (stage.kind !== 'deploying') throw new Error('expected the deploying stage')
    expect(stage.steps).toEqual([
      { id: 'setup', state: 'done', detail: DEPLOY_SETUP_DONE_WITH_OWNER_DETAIL },
      {
        id: 'start-ui',
        state: 'running',
        detail: deployWaitingDetail(START_READY_TIMEOUT_MS),
      },
      { id: 'start-serve', state: 'pending' },
    ])
    expect(stage.admin).toEqual(MINTED_ADMIN)
    expect(stage.output?.command).toContain('setup --yes')
    expect(step.effects).toEqual([
      {
        kind: 'wizard-run',
        step: 'start-ui',
        request: { actionId: 'start-ui', argv: ['start', 'ui'], display: ['start', 'ui'] },
      },
    ])
  })

  test('the transcript under the ladder does not carry the token setup printed', () => {
    const step = update(deployingModel(), resultMsg('setup', { stdout: SETUP_STDOUT }))

    const stage = stageOf(step.model)
    if (stage.kind !== 'deploying') throw new Error('expected the deploying stage')
    expect(stage.output?.lines.join('\n')).not.toContain(MINTED_ADMIN.token)
    // The line is still there, so the transcript is not silently short of one.
    expect(stage.output?.lines.some((line) => line.startsWith('token: '))).toBe(true)
  })

  test('a token setup wrote to stderr is masked too', () => {
    const step = update(
      deployingModel(),
      resultMsg('setup', { stdout: SETUP_STDOUT, stderr: `warn: reusing ${SECRET}\n` }),
    )

    expect(transcriptOf(step.model)).not.toContain(SECRET)
    expect(transcriptOf(step.model)).toContain(DEPLOY_TOKEN_PLACEHOLDER)
  })

  test('a token no admin line names is masked all the same', () => {
    // `mintedAdminOf` answers nothing without both lines, and the mask must
    // not be the thing that depends on it: a transcript is masked because it
    // holds a token, not because the wizard managed to parse one out of it.
    const step = update(deployingModel(), resultMsg('setup', { stdout: `token: ${SECRET}\n` }))

    expect(transcriptOf(step.model)).not.toContain(SECRET)
  })

  test('the transcript of a setup that failed is masked as well', () => {
    const step = update(
      deployingModel(),
      resultMsg('setup', { exitCode: 1, stdout: `token: ${SECRET}\n`, stderr: 'setup: failed\n' }),
    )

    expect(stageOf(step.model).kind).toBe('setup-failed')
    expect(transcriptOf(step.model)).not.toContain(SECRET)
  })

  test('every occurrence of a token goes, not only the first', () => {
    const step = update(
      deployingModel(),
      resultMsg('setup', {
        stdout: `token: ${SECRET}\nagain: ${SECRET}\n`,
        stderr: `and once more: ${SECRET}\n`,
      }),
    )

    expect(transcriptOf(step.model).split(DEPLOY_TOKEN_PLACEHOLDER)).toHaveLength(4)
    expect(transcriptOf(step.model)).not.toContain(SECRET)
  })

  test('a rerun that minted nobody carries no token', () => {
    const step = update(deployingModel(), resultMsg('setup', { stdout: SETUP_STDOUT_NO_TOKEN }))

    const stage = stageOf(step.model)
    expect(stage.kind === 'deploying' && stage.steps[0]?.detail).toBe(DEPLOY_SETUP_DONE_DETAIL)
    expect(stage.kind === 'deploying' && stage.admin).toBeUndefined()
  })

  test('an external supervisor skips both starts and finishes', () => {
    const step = update(
      deployingModel(externalConfig()),
      resultMsg('setup', { stdout: SETUP_STDOUT }),
    )

    const stage = stageOf(step.model)
    expect(step.effects).toEqual([])
    expect(stage).toEqual({
      kind: 'done',
      quitAsked: false,
      admin: MINTED_ADMIN,
      steps: [
        { id: 'setup', state: 'done', detail: DEPLOY_SETUP_DONE_WITH_OWNER_DETAIL },
        { id: 'start-ui', state: 'skipped', detail: DEPLOY_EXTERNAL_DETAIL },
        { id: 'start-serve', state: 'skipped', detail: DEPLOY_EXTERNAL_DETAIL },
      ],
    })
  })
})

describe('updateWizard: the services starting', () => {
  test('a started service is marked with the first line it answered', () => {
    const step = update(afterSetupModel(), resultMsg('start-ui', { stdout: START_UI_STDOUT }))

    const stage = stageOf(step.model)
    if (stage.kind !== 'deploying') throw new Error('expected the deploying stage')
    expect(stage.steps[1]).toEqual({
      id: 'start-ui',
      state: 'done',
      detail: START_UI_STDOUT.trim(),
    })
    expect(stage.steps[2]?.state).toBe('running')
    expect(stage.admin).toEqual(MINTED_ADMIN)
    expect(step.effects).toEqual([
      {
        kind: 'wizard-run',
        step: 'start-serve',
        request: { actionId: 'start-serve', argv: ['start', 'serve'], display: ['start', 'serve'] },
      },
    ])
  })

  test('a service that did not start does not stop the next one', () => {
    const step = update(
      afterSetupModel(),
      resultMsg('start-ui', { exitCode: 3, stdout: '', stderr: 'ui: address already in use\n' }),
    )

    const stage = stageOf(step.model)
    expect(stage.kind === 'deploying' && stage.steps[1]).toEqual({
      id: 'start-ui',
      state: 'failed',
      detail: 'ui: address already in use',
    })
    expect(step.effects).toEqual([
      {
        kind: 'wizard-run',
        step: 'start-serve',
        request: { actionId: 'start-serve', argv: ['start', 'serve'], display: ['start', 'serve'] },
      },
    ])
  })

  test('a rung that said nothing at all falls back to its exit code', () => {
    const step = update(afterSetupModel(), resultMsg('start-ui', { exitCode: 3 }))

    const stage = stageOf(step.model)
    expect(stage.kind === 'deploying' && stage.steps[1]?.detail).toBe(deployExitDetail(3))
  })

  test('the last rung ends the deploy', () => {
    const ui = update(afterSetupModel(), resultMsg('start-ui', { stdout: START_UI_STDOUT })).model

    const step = update(ui, resultMsg('start-serve', { stdout: START_SERVE_STDOUT }))

    const stage = stageOf(step.model)
    expect(step.effects).toEqual([])
    expect(stage.kind).toBe('done')
    if (stage.kind !== 'done') throw new Error('expected the final stage')
    expect(stage.quitAsked).toBe(false)
    expect(stage.admin).toEqual(MINTED_ADMIN)
    expect(stage.steps[2]).toEqual({
      id: 'start-serve',
      state: 'done',
      detail: START_SERVE_STDOUT.trim(),
    })
  })
})

describe('updateWizard: results that belong to nobody', () => {
  test('a result for a rung that is not running is dropped', () => {
    const model = deployingModel()

    const step = update(model, resultMsg('start-ui', { stdout: START_UI_STDOUT }))

    expect(step.model).toBe(model)
    expect(step.effects).toEqual([])
  })

  test('a result that arrives on the form is dropped', () => {
    const model = wizardModel()

    const step = update(model, resultMsg('setup', { stdout: SETUP_STDOUT }))

    expect(step.model).toBe(model)
  })

  test('messages meant for the console are dropped', () => {
    const model = deployingModel()

    expect(update(model, { kind: 'services', statuses: [] }).model).toBe(model)
    expect(
      update(model, { kind: 'run-result', result: runResult() }).model,
    ).toBe(model)
    expect(update(model, { kind: 'session-lost' }).model).toBe(model)
  })

  test('a resize still applies mid-deploy', () => {
    const size: TerminalSize = { columns: 40, rows: 10 }

    const step = update(deployingModel(), { kind: 'resize', size })

    expect(step.model.size).toEqual(size)
    expect(stageOf(step.model).kind).toBe('deploying')
  })
})

describe('updateWizard: the final screen with a token', () => {
  test('yes hands the console over', () => {
    const step = update(doneModel(), char('y'))

    expect(step.effects).toEqual([
      { kind: 'wizard-finish' },
      { kind: 'quit', exitCode: EXIT_OK },
    ])
  })

  test.each([['q'], ['escape']])('%s asks about the token first', (answer) => {
    const step = update(doneModel(), answer === 'escape' ? key('escape') : char(answer))

    const stage = stageOf(step.model)
    expect(step.effects).toEqual([])
    expect(stage.kind === 'done' && stage.quitAsked).toBe(true)
  })

  test('anything else leaves the final screen alone', () => {
    const model = doneModel()

    const step = update(model, key('down'))

    expect(step.model).toBe(model)
  })

  test('no takes the question back off the screen', () => {
    const asked = update(doneModel(), char('q')).model

    const step = update(asked, char('n'))

    const stage = stageOf(step.model)
    expect(stage.kind === 'done' && stage.quitAsked).toBe(false)
    expect(step.effects).toEqual([])
  })

  test('yes to the question leaves with code 0', () => {
    const asked = update(doneModel(), char('q')).model

    const step = update(asked, char('y'))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
  })
})

describe('updateWizard: the final screen without a token', () => {
  test('Enter hands the console over', () => {
    const step = update(doneModel(SETUP_STDOUT_NO_TOKEN), key('enter'))

    expect(step.effects).toEqual([
      { kind: 'wizard-finish' },
      { kind: 'quit', exitCode: EXIT_OK },
    ])
  })

  test.each([['q'], ['escape']])('%s leaves at once — there is nothing to save', (answer) => {
    const model = doneModel(SETUP_STDOUT_NO_TOKEN)

    const step = update(model, answer === 'escape' ? key('escape') : char(answer))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
  })
})

describe('updateWizard: nothing mutates the model it was handed', () => {
  const cases: ReadonlyArray<readonly [string, () => Model, Msg]> = [
    ['form: typing', () => wizardModel(), char('z')],
    ['form: focus', () => wizardModel(), key('tab')],
    ['form: deploy', () => wizardModel(), key('enter')],
    ['form: exposure question', () => wizardModel(exposedConfig()), key('enter')],
    [
      'exposure: yes',
      () => update(wizardModel(exposedConfig()), key('enter')).model,
      char('y'),
    ],
    [
      'exposure: no',
      () => update(wizardModel(exposedConfig()), key('enter')).model,
      char('n'),
    ],
    ['deploying: setup done', () => deployingModel(), resultMsg('setup', { stdout: SETUP_STDOUT })],
    ['deploying: setup failed', () => deployingModel(), resultMsg('setup', { exitCode: 1 })],
    ['deploying: external', () => deployingModel(externalConfig()), resultMsg('setup', { stdout: SETUP_STDOUT })],
    [
      'deploying: scroll',
      () => update(deployingModel(), resultMsg('setup', { stdout: longStdout(100) })).model,
      key('pagedown'),
    ],
    ['deploying: start-ui', () => afterSetupModel(), resultMsg('start-ui', { stdout: START_UI_STDOUT })],
    [
      'deploying: start-serve',
      () => update(afterSetupModel(), resultMsg('start-ui', { stdout: START_UI_STDOUT })).model,
      resultMsg('start-serve', { stdout: START_SERVE_STDOUT }),
    ],
    [
      'setup-failed: retry',
      () => update(deployingModel(), resultMsg('setup', { exitCode: 1 })).model,
      key('enter'),
    ],
    [
      'setup-failed: scroll',
      () => update(deployingModel(), resultMsg('setup', { exitCode: 1, stdout: longStdout(100) })).model,
      key('home'),
    ],
    ['done: sign in', () => doneModel(), char('y')],
    ['done: quit question', () => doneModel(), char('q')],
    ['done: question answered', () => update(doneModel(), char('q')).model, char('n')],
    ['done: no token', () => doneModel(SETUP_STDOUT_NO_TOKEN), key('enter')],
  ]

  test.each(cases)('%s', (_name, modelOf, msg) => {
    const model = modelOf()
    const before = snapshotOf(model)
    deepFreeze(model)

    update(model, msg)

    expect(model).toEqual(before)
  })
})
