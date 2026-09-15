import { describe, expect, test } from 'vitest'
import { visibleSections } from '../../src/tui/catalogue/index.js'
import type { SectionSpec } from '../../src/tui/catalogue/types.js'
import {
  APPROVALS_POLL_INTERVAL_MS,
  WIZARD_STOPWATCH_INTERVAL_MS,
} from '../../src/tui/constants-live.js'
import { formOf } from '../../src/tui/form.js'
import {
  initialModel,
  mainScreenOf,
  type DeployStepId,
  type MainScreen,
  type Model,
  type Session,
  type TerminalSize,
  type WizardScreen,
  type WizardStage,
} from '../../src/tui/model.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import { subscriptionOf } from '../../src/tui/subscriptions.js'
import { wizardScreenOf } from '../../src/tui/wizard-fields.js'

/**
 * The console's one subscription (mcpcut phase 5, Task 4).
 *
 * `subscriptionOf` is asked the same question by both sides — the runtime
 * reconciles its single timer against it after every step, and the reducer
 * asks it again when the tick arrives — so what these cases pin is not "a
 * timer runs" but WHEN the answer is `undefined`: a tab that reads nothing on
 * its own, a run already in flight, a poll not yet answered, and every pane
 * that is not the action list (a form being filled, a question waiting, the
 * help, the quit question, a one-time token nobody has saved yet).
 */

const SIZE: TerminalSize = { columns: 80, rows: 24 }
const SESSION: Session = { adminName: 'root', role: 'owner' }

function mainScreen(patch: Partial<MainScreen> = {}): MainScreen {
  const screen = mainScreenOf(SESSION, visibleSections('owner'))
  if (screen.kind !== 'main') throw new Error('mainScreenOf must build a main screen')

  return { ...screen, ...patch }
}

function tabOf(id: string): number {
  return visibleSections('owner').findIndex((section) => section.id === id)
}

function modelOn(id: string, patch: Partial<MainScreen> = {}): Model {
  return { screen: mainScreen({ sectionIndex: tabOf(id), ...patch }), size: SIZE }
}

/** The first-run wizard, at whichever stage the case needs. */
function wizardScreen(stage: WizardStage): WizardScreen {
  const config = defaultInstallConfig('/var/lib/x')
  const screen = wizardScreenOf({ mode: 'first-run', configPath: '/home/op/.mcpcut/config.json', config })

  return { ...screen, stage }
}

/** The deploy ladder with exactly one rung running. */
function deployingWith(running: DeployStepId): WizardStage {
  const ids: readonly DeployStepId[] = ['setup', 'start-ui', 'start-serve']
  const steps = ids.map((id) => ({ id, state: id === running ? 'running' : 'pending' }) as const)

  return { kind: 'deploying', steps }
}

/** A tab that claims a timer but names no reader — the shape the invariant forbids. */
const POLLED_WITHOUT_REFRESH: SectionSpec = {
  id: 'polled',
  title: 'Polled',
  minRole: 'viewer',
  intro: [],
  autoRefreshMs: 1_000,
  actions: [
    {
      id: 'noop',
      title: 'status',
      minRole: 'viewer',
      command: 'status',
      fields: [],
      argv: () => ['status'],
    },
  ],
}

/** …and one whose reader needs a form filled in, which a timer cannot do. */
const POLLED_WITH_FORM: SectionSpec = {
  id: 'polled-form',
  title: 'Polled',
  minRole: 'viewer',
  intro: [],
  autoRefreshMs: 1_000,
  refreshActionId: 'ask',
  actions: [
    {
      id: 'ask',
      title: 'status',
      minRole: 'viewer',
      command: 'status',
      fields: [{ name: 'since', label: 'Since', kind: 'text' }],
      argv: () => ['status'],
    },
  ],
}

function modelOnSection(section: SectionSpec, patch: Partial<MainScreen> = {}): Model {
  return {
    screen: mainScreen({ sections: [section], sectionIndex: 0, ...patch }),
    size: SIZE,
  }
}

describe('the tab that reads itself', () => {
  test('Approvals, idle on its action list, asks to be polled', () => {
    expect(subscriptionOf(modelOn('approvals'))).toBe(APPROVALS_POLL_INTERVAL_MS)
  })

  test('a tab that declares no interval is never polled', () => {
    expect(subscriptionOf(modelOn('home'))).toBeUndefined()
    expect(subscriptionOf(modelOn('journal'))).toBeUndefined()
  })
})

describe('nothing is polled over the top of something else', () => {
  test('a run in flight holds the timer back', () => {
    const model = modelOn('approvals', {
      busy: { actionId: 'list', argv: ['approvals', 'list'], display: ['approvals', 'list'] },
    })

    expect(subscriptionOf(model)).toBeUndefined()
  })

  test('a poll already in flight is not asked twice', () => {
    expect(subscriptionOf(modelOn('approvals', { polling: 'approvals' }))).toBeUndefined()
  })

  test.each([
    ['form', { kind: 'form' as const, actionId: 'approve', form: formOf([]) }],
    [
      'confirm',
      {
        kind: 'confirm' as const,
        actionId: 'deny',
        request: { actionId: 'deny', argv: ['approvals', 'deny'], display: ['approvals', 'deny'] },
        question: 'Deny?',
      },
    ],
    ['help', { kind: 'help' as const }],
    ['quit-confirm', { kind: 'quit-confirm' as const }],
    ['token-hold', { kind: 'token-hold' as const }],
  ])('the %s pane owns the screen, so the tick would steal it', (_name, pane) => {
    expect(subscriptionOf(modelOn('approvals', { pane }))).toBeUndefined()
  })
})

describe('a screen with no action list has no subscription at all', () => {
  test('sign-in polls nothing', () => {
    expect(subscriptionOf(initialModel(SIZE))).toBeUndefined()
  })

  test('the wizard on its form polls nothing', () => {
    expect(subscriptionOf({ screen: wizardScreen({ kind: 'form' }), size: SIZE })).toBeUndefined()
  })
})

describe('an interval alone is not enough: there must be something to run', () => {
  test('a tab with an interval but no refresh action is not polled', () => {
    expect(subscriptionOf(modelOnSection(POLLED_WITHOUT_REFRESH))).toBeUndefined()
  })

  test('a refresh action with a form is not polled either', () => {
    expect(subscriptionOf(modelOnSection(POLLED_WITH_FORM))).toBeUndefined()
  })

  test('a section index outside the list answers undefined rather than crashing', () => {
    expect(subscriptionOf(modelOn('approvals', { sectionIndex: 99 }))).toBeUndefined()
  })
})

describe('the wizard counts seconds while a service is starting (F8)', () => {
  test.each([['start-ui'], ['start-serve']] as const)(
    'the deploying stage with %s running subscribes to the stopwatch',
    (running) => {
      const model: Model = { screen: wizardScreen(deployingWith(running)), size: SIZE }

      expect(subscriptionOf(model)).toBe(WIZARD_STOPWATCH_INTERVAL_MS)
    },
  )

  test('`setup` running counts nothing: its wait has no fixed limit to count against', () => {
    const model: Model = { screen: wizardScreen(deployingWith('setup')), size: SIZE }

    expect(subscriptionOf(model)).toBeUndefined()
  })

  test('the final screen counts nothing', () => {
    const stage: WizardStage = { kind: 'done', steps: deployingWith('setup').steps, quitAsked: false }

    expect(subscriptionOf({ screen: wizardScreen(stage), size: SIZE })).toBeUndefined()
  })

  test('the main screen answers as it did before the wizard had a subscription', () => {
    expect(subscriptionOf(modelOn('approvals'))).toBe(APPROVALS_POLL_INTERVAL_MS)
    expect(subscriptionOf(modelOn('home'))).toBeUndefined()
  })
})
