import { describe, expect, test } from 'vitest'
import type { TokenAdmin } from '../../src/cli/admin-token.js'
import { visibleSections } from '../../src/tui/catalogue/index.js'
import { EXIT_OK, SIGNIN_UNKNOWN_TOKEN_NOTICE } from '../../src/tui/constants.js'
import { initialModel, type Model, type Msg, type RunRequest } from '../../src/tui/model.js'
import type { RunResult } from '../../src/tui/output.js'
import { update } from '../../src/tui/update.js'
import { EMPTY_TOKEN_NOTICE } from '../../src/tui/update-signin.js'
import {
  ADMINS_TAB,
  ONE_TIME_STDOUT,
  OWNER_SECTION_IDS,
  SIZE,
  VIEWER_SECTION_IDS,
  char,
  ctrl,
  deepFreeze,
  key,
  mainModel,
  mainOf,
  panelOf,
  signinOf,
  snapshotOf,
  typed,
  wizardModel,
} from './support/update-fixtures.js'

/**
 * The reducer is the whole of the console's behaviour: every keystroke, every
 * answer from an effect, and every exit path is one pure `(model, msg) → step`
 * away from a frame. Nothing here touches a terminal, a store or a clock, so
 * each case below is the AAA triple it looks like.
 *
 * This file holds the entry point (resize, Ctrl-C) and the sign-in screen, and
 * the two invariants that get their own tables at the end. Nothing mutates the
 * model it was handed (a reducer that did would let a stale frame and the next
 * step disagree), and nothing on the sign-in screen answers a message meant
 * for a session that has already ended (the race after `session-lost`).
 *
 * The main screen is split by theme (phase 6, task 9): moving between sections
 * and actions, runs and `r` in `update-sections.test.ts`; the output pane,
 * help and quit in `update-output.test.ts`; the form and confirmation panes
 * and what a run carries in `update-form.test.ts`. The fixtures they share
 * live in `support/update-fixtures.ts`.
 */

describe('update: the entry point', () => {
  test('resize replaces the size and leaves the screen alone', () => {
    const model = mainModel()

    const step = update(model, { kind: 'resize', size: { columns: 40, rows: 10 } })

    expect(step.model.size).toEqual({ columns: 40, rows: 10 })
    expect(step.model.screen).toBe(model.screen)
    expect(step.effects).toEqual([])
  })

  test('resize applies while a run is in flight', () => {
    const busy: RunRequest = { actionId: 'list', argv: ['admin', 'list'], display: ['admin', 'list'] }

    const step = update(mainModel({ busy }), { kind: 'resize', size: { columns: 100, rows: 50 } })

    expect(step.model.size).toEqual({ columns: 100, rows: 50 })
    expect(mainOf(step.model).busy).toEqual(busy)
  })

  test('Ctrl-C quits from the sign-in screen', () => {
    const step = update(initialModel(SIZE), ctrl('c'))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
  })

  test('Ctrl-C quits from the main screen', () => {
    const step = update(mainModel(), ctrl('c'))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
  })

  test('Ctrl-C quits even while a run is in flight', () => {
    const busy: RunRequest = { actionId: 'list', argv: ['admin', 'list'], display: ['admin', 'list'] }

    const step = update(mainModel({ busy }), ctrl('c'))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
  })

  test('another Ctrl combination is not a quit', () => {
    const step = update(mainModel(), ctrl('d'))

    expect(step.effects).toEqual([])
  })

  // What every other key does while a run is in flight — queued since phase 6
  // (F5), no longer dropped — is pinned in `update-keys.test.ts`.
})

describe('update: the sign-in screen', () => {
  test('a printable key reaches the token field', () => {
    const step = update(initialModel(SIZE), char('m'))

    expect(signinOf(step.model).form.fields[0]?.value).toBe('m')
    expect(step.effects).toEqual([])
  })

  test('backspace removes the last character', () => {
    const model = typed(initialModel(SIZE), 'ab')

    const step = update(model, key('backspace'))

    expect(signinOf(step.model).form.fields[0]?.value).toBe('a')
  })

  test('a key the field has no use for leaves the model untouched', () => {
    const model = initialModel(SIZE)

    const step = update(model, key('right'))

    expect(step.model).toBe(model)
  })

  test('Enter with an empty token asks for one instead of signing in', () => {
    const step = update(initialModel(SIZE), key('enter'))

    expect(signinOf(step.model).notice).toBe(EMPTY_TOKEN_NOTICE)
    expect(signinOf(step.model).busy).toBe(false)
    expect(step.effects).toEqual([])
  })

  test('Enter with a token asks the runtime to sign in and clears the field', () => {
    const model = typed(initialModel(SIZE), 'mcpa_secret')

    const step = update(model, key('enter'))

    expect(step.effects).toEqual([{ kind: 'signin', token: 'mcpa_secret' }])
    expect(signinOf(step.model).form.fields[0]?.value).toBe('')
    expect(signinOf(step.model).busy).toBe(true)
    expect(signinOf(step.model).notice).toBeUndefined()
  })

  test('the token is taken exactly as typed, spaces included', () => {
    const model = typed(initialModel(SIZE), ' mcpa_x ')

    const step = update(model, key('enter'))

    expect(step.effects).toEqual([{ kind: 'signin', token: ' mcpa_x ' }])
  })

  test('Escape quits', () => {
    const step = update(initialModel(SIZE), key('escape'))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
  })

  test('a resolved token opens the main screen and asks for the service line', () => {
    const result: TokenAdmin = { kind: 'ok', name: 'root', role: 'owner' }

    const step = update(initialModel(SIZE), { kind: 'signin-result', result })

    const screen = mainOf(step.model)
    expect(screen.session).toEqual({ adminName: 'root', role: 'owner' })
    expect(screen.sections).toEqual(visibleSections('owner'))
    expect(screen.pane).toEqual({ kind: 'actions' })
    expect(step.effects).toEqual([{ kind: 'refresh-services' }])
  })

  test('a viewer sees only the sections a viewer may use', () => {
    const result: TokenAdmin = { kind: 'ok', name: 'reader', role: 'viewer' }

    const step = update(initialModel(SIZE), { kind: 'signin-result', result })

    expect(mainOf(step.model).sections.map((section) => section.id)).toEqual(VIEWER_SECTION_IDS)
  })

  test('an owner sees the whole catalogue, in catalogue order', () => {
    const result: TokenAdmin = { kind: 'ok', name: 'root', role: 'owner' }

    const step = update(initialModel(SIZE), { kind: 'signin-result', result })

    expect(mainOf(step.model).sections.map((section) => section.id)).toEqual(OWNER_SECTION_IDS)
  })

  test.each([
    ['unknown' as const],
    ['missing' as const],
  ])('a %s token says so without saying which', (kind) => {
    const step = update(initialModel(SIZE), { kind: 'signin-result', result: { kind } })

    expect(signinOf(step.model).notice).toBe(SIGNIN_UNKNOWN_TOKEN_NOTICE)
    expect(signinOf(step.model).busy).toBe(false)
    expect(step.effects).toEqual([])
  })

  test('an unreadable store shows what went wrong with it', () => {
    const result: TokenAdmin = { kind: 'unreadable', detail: 'admins.json: unexpected token' }

    const step = update(initialModel(SIZE), { kind: 'signin-result', result })

    expect(signinOf(step.model).notice).toBe('admins.json: unexpected token')
    expect(signinOf(step.model).busy).toBe(false)
  })

  test.each([
    [
      'run-result',
      {
        kind: 'run-result',
        result: { argv: ['admin', 'list'], display: ['admin', 'list'], exitCode: 0, stdout: 'x', stderr: '' },
      } satisfies Msg,
    ],
    ['session-lost', { kind: 'session-lost' } satisfies Msg],
    // `services` is NOT here any more (phase 5): what the daemons are doing is
    // a fact about the host, not a dead session's output, and the sign-in
    // screen draws it — `update-live.test.ts` holds that half.
  ])('%s is ignored on the sign-in screen', (_name, msg) => {
    const model = initialModel(SIZE)

    const step = update(model, msg)

    expect(step.model).toBe(model)
    expect(step.effects).toEqual([])
  })
})

describe('update: nothing mutates the model it was handed', () => {
  const request: RunRequest = { actionId: 'list', argv: ['admin', 'list'], display: ['admin', 'list'] }
  const runResult: RunResult = {
    argv: ['admin', 'list'],
    display: ['admin', 'list'],
    exitCode: 0,
    stdout: 'alice owner\n',
    stderr: '',
  }

  const cases: ReadonlyArray<readonly [string, Model, Msg]> = [
    ['sign-in: typing', initialModel(SIZE), char('m')],
    ['sign-in: Enter', typed(initialModel(SIZE), 'mcpa_x'), key('enter')],
    ['sign-in: resolved', initialModel(SIZE), { kind: 'signin-result', result: { kind: 'ok', name: 'root', role: 'owner' } }],
    ['sign-in: rejected', initialModel(SIZE), { kind: 'signin-result', result: { kind: 'unknown' } }],
    ['main: next section', mainModel(), key('tab')],
    ['main: next action', mainModel({ sectionIndex: ADMINS_TAB }), key('down')],
    ['main: run', mainModel({ sectionIndex: ADMINS_TAB }), key('enter')],
    ['main: open a form', mainModel({ sectionIndex: ADMINS_TAB, actionIndex: 1 }), key('enter')],
    ['main: refresh', mainModel({ sectionIndex: ADMINS_TAB }), char('r')],
    ['main: finished run', mainModel({ busy: request }), { kind: 'run-result', result: runResult }],
    ['main: services', mainModel(), { kind: 'services', statuses: [] }],
    ['main: session lost', mainModel({ output: panelOf(2) }), { kind: 'session-lost' }],
    ['main: scroll', mainModel({ output: panelOf(100) }), key('pagedown')],
    ['main: help', mainModel(), char('?')],
    ['main: quit question', mainModel({ output: panelOf(1, { stdout: ONE_TIME_STDOUT }) }), char('q')],
    ['main: resize', mainModel(), { kind: 'resize', size: { columns: 40, rows: 10 } }],
    ['wizard: typing', wizardModel(), char('z')],
    ['wizard: deploy', wizardModel(), key('enter')],
    [
      'wizard: finished step',
      update(wizardModel(), key('enter')).model,
      { kind: 'wizard-run-result', step: 'setup', result: { ...runResult, stdout: 'admin: owner\ntoken: mcpa_x\n' } },
    ],
  ]

  test.each(cases)('%s', (_name, model, msg) => {
    const before = snapshotOf(model)
    deepFreeze(model)

    update(model, msg)

    expect(model).toEqual(before)
  })
})

describe('update: one sign-in at a time', () => {
  test('a second Enter while the store is answering queues nothing', () => {
    const first = update(typed(initialModel({ columns: 80, rows: 24 }), 'mcpa_x'), key('enter'))
    expect(first.effects).toHaveLength(1)

    const second = update(first.model, key('enter'))

    expect(second.effects).toEqual([])
    expect(second.model).toEqual(first.model)
  })
})
