import { describe, expect, test } from 'vitest'
import { BOOTSTRAP_ADMIN_NAME } from '../../src/cli/ui-constants.js'
import { START_READY_TIMEOUT_MS } from '../../src/services/constants.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import { deployWaitingDetail } from '../../src/tui/constants.js'
import type { KeyEvent, NamedKey } from '../../src/tui/keys.js'
import type { DeployStepId, Model, Msg, TerminalSize, WizardStage } from '../../src/tui/model.js'
import type { RunResult } from '../../src/tui/output.js'
import { update } from '../../src/tui/update.js'
import { wizardScreenOf } from '../../src/tui/wizard-fields.js'

/**
 * The wizard's stopwatch (mcpcut phase 6, F8 / P8). While a `start-*` rung
 * waits on its service the manager answers nothing for up to
 * `START_READY_TIMEOUT_MS`, so the only thing that can move on the screen is
 * a count the console keeps itself: each `tick` adds a second to the running
 * rung's detail. It is a count of ticks, not a clock — the reducer stays
 * pure, and a second of drift is nothing against a fifteen-second wait.
 *
 * Its own file rather than more cases in `update-wizard.test.ts`, which is
 * near the file budget; the helpers below are the minimum copied from it.
 */

const SIZE: TerminalSize = { columns: 80, rows: 24 }
const TICK: Msg = { kind: 'tick' }
const THREE_TICKS = 3

const SETUP_STDOUT = `admin: ${BOOTSTRAP_ADMIN_NAME}\nrole: owner\ntoken: mcpa_x\n`
const START_UI_STDOUT = 'ui:    started pid 1 on http://127.0.0.1:8091/\n'

function key(kind: NamedKey): Msg {
  return { kind: 'key', key: { kind } as KeyEvent }
}

function wizardModel(): Model {
  const config = defaultInstallConfig('/var/lib/x')
  const screen = wizardScreenOf({ mode: 'first-run', configPath: '/home/op/.mcpcut/config.json', config })

  return { screen, size: SIZE }
}

function stageOf(model: Model): WizardStage {
  if (model.screen.kind !== 'wizard') throw new Error(`expected a wizard, got ${model.screen.kind}`)

  return model.screen.stage
}

function deployingOf(model: Model): Extract<WizardStage, { kind: 'deploying' }> {
  const stage = stageOf(model)
  if (stage.kind !== 'deploying') throw new Error(`expected the deploying stage, got ${stage.kind}`)

  return stage
}

function resultMsg(step: DeployStepId, stdout: string): Msg {
  const argv = step === 'setup' ? ['setup'] : ['start', step === 'start-ui' ? 'ui' : 'serve']
  const result: RunResult = { argv, display: argv, exitCode: 0, stdout, stderr: '' }

  return { kind: 'wizard-run-result', step, result }
}

/** A wizard with `setup` in flight. */
function setupRunningModel(): Model {
  return deepFreeze(update(wizardModel(), key('enter')).model)
}

/** A wizard that finished `setup` and is waiting on `start ui`. */
function startUiRunningModel(): Model {
  return deepFreeze(update(setupRunningModel(), resultMsg('setup', SETUP_STDOUT)).model)
}

function ticked(model: Model, times: number): Model {
  return Array.from({ length: times }).reduce<Model>(
    (current) => deepFreeze(update(current, TICK).model),
    model,
  )
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const each of Object.values(value)) deepFreeze(each)

  return Object.freeze(value)
}

describe('updateWizard: the stopwatch beside a starting service', () => {
  test('three ticks say three seconds of the wait have gone', () => {
    const model = ticked(startUiRunningModel(), THREE_TICKS)

    const stage = deployingOf(model)
    expect(stage.waitedTicks).toBe(THREE_TICKS)
    expect(stage.steps[1]).toEqual({
      id: 'start-ui',
      state: 'running',
      detail: deployWaitingDetail(START_READY_TIMEOUT_MS, THREE_TICKS),
    })
    expect(stage.steps[1]?.detail).toContain('(3 s of up to 15 s)')
  })

  test('a tick asks the runtime for nothing and leaves the transcript alone', () => {
    const model = startUiRunningModel()

    const step = update(model, TICK)

    expect(step.effects).toEqual([])
    expect(deployingOf(step.model).output).toBe(deployingOf(model).output)
    expect(deployingOf(step.model).admin).toBe(deployingOf(model).admin)
  })

  test('the count starts again from nothing when the next service begins', () => {
    const waited = ticked(startUiRunningModel(), THREE_TICKS)

    const step = update(waited, resultMsg('start-ui', START_UI_STDOUT))

    const stage = deployingOf(step.model)
    expect('waitedTicks' in stage).toBe(false)
    expect(stage.steps[2]).toEqual({
      id: 'start-serve',
      state: 'running',
      detail: deployWaitingDetail(START_READY_TIMEOUT_MS),
    })
  })

  test('the count goes on for the second service', () => {
    const ui = update(startUiRunningModel(), resultMsg('start-ui', START_UI_STDOUT)).model

    const model = ticked(deepFreeze(ui), 1)

    expect(deployingOf(model).steps[2]?.detail).toBe(deployWaitingDetail(START_READY_TIMEOUT_MS, 1))
  })

  test('a tick while `setup` runs is nothing to do', () => {
    const model = setupRunningModel()

    const step = update(model, TICK)

    expect(step.model).toBe(model)
    expect(step.effects).toEqual([])
  })

  test('a tick on the form is nothing to do', () => {
    const model = deepFreeze(wizardModel())

    const step = update(model, TICK)

    expect(step.model).toBe(model)
    expect(step.effects).toEqual([])
  })

  test('a tick on the final screen is nothing to do', () => {
    const ui = update(startUiRunningModel(), resultMsg('start-ui', START_UI_STDOUT)).model
    const done = deepFreeze(update(ui, resultMsg('start-serve', 'serve: started\n')).model)
    expect(stageOf(done).kind).toBe('done')

    const step = update(done, TICK)

    expect(step.model).toBe(done)
    expect(step.effects).toEqual([])
  })
})
