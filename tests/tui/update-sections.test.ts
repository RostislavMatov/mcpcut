import { describe, expect, test } from 'vitest'
import { ONE_TIME_TOKEN_MARKER, SESSION_LOST_NOTICE } from '../../src/tui/constants.js'
import type { RunRequest } from '../../src/tui/model.js'
import type { RunResult } from '../../src/tui/output.js'
import type { ServiceSummary } from '../../src/tui/services-summary.js'
import { update } from '../../src/tui/update.js'
import {
  ADMINS_TAB,
  APPROVALS_TAB,
  AUDIT_TAB,
  HOME_TAB,
  JOURNAL_TAB,
  NO_SUCH_TAB,
  PLAIN_SECTION,
  SERVERS_TAB,
  SERVICES_TAB,
  SIZE,
  char,
  key,
  mainModel,
  mainOf,
  panelOf,
  signinOf,
} from './support/update-fixtures.js'

/**
 * The reducer on the main screen's action list: moving between sections and
 * between actions, running one, the answers a run and the header get back,
 * and the `r` key. Split out of `update.test.ts` (phase 6, task 9); the
 * fixtures are in `support/update-fixtures.ts`.
 */

describe('update: moving between sections', () => {
  test.each([
    ['tab', key('tab')],
    ['right', key('right')],
    ['l', char('l')],
  ])('%s moves to the next section', (_name, msg) => {
    const step = update(mainModel(), msg)

    expect(mainOf(step.model).sectionIndex).toBe(ADMINS_TAB)
  })

  test.each([
    ['backtab', key('backtab')],
    ['left', key('left')],
    ['h', char('h')],
  ])('%s moves to the previous section, wrapping past the first', (_name, msg) => {
    const step = update(mainModel(), msg)

    expect(mainOf(step.model).sectionIndex).toBe(SERVICES_TAB)
  })

  test('the next section wraps past the last', () => {
    const step = update(mainModel({ sectionIndex: SERVICES_TAB }), key('tab'))

    expect(mainOf(step.model).sectionIndex).toBe(HOME_TAB)
  })

  test('switching sections puts the cursor on the first action', () => {
    const step = update(mainModel({ sectionIndex: ADMINS_TAB, actionIndex: 3 }), key('tab'))

    expect(mainOf(step.model).actionIndex).toBe(0)
  })

  test('a digit jumps straight to a section', () => {
    const step = update(mainModel({ actionIndex: 2 }), char('2'))

    expect(mainOf(step.model).sectionIndex).toBe(ADMINS_TAB)
    expect(mainOf(step.model).actionIndex).toBe(0)
  })

  test.each([
    ['3', 'servers'],
    ['9', 'approvals'],
  ])('the digit %s jumps to the %s section', (digit, id) => {
    const step = update(mainModel({ sectionIndex: HOME_TAB }), char(digit))

    const screen = mainOf(step.model)
    expect(screen.sections[screen.sectionIndex]?.id).toBe(id)
  })

  test('the tenth and eleventh sections have no digit and are reached by Tab alone', () => {
    const step = update(mainModel({ sectionIndex: JOURNAL_TAB }), key('tab'))

    expect(mainOf(step.model).sectionIndex).toBe(AUDIT_TAB)
  })

  test('the digit 0 names no section and changes nothing', () => {
    const model = mainModel({ sectionIndex: ADMINS_TAB, actionIndex: 2 })

    const step = update(model, char('0'))

    expect(step.model).toBe(model)
  })

  test('a digit past the sections on screen changes nothing', () => {
    const model = mainModel({ sections: [PLAIN_SECTION] })

    const step = update(model, char('9'))

    expect(step.model).toBe(model)
  })

  test('a section switch requests nothing of the runtime', () => {
    expect(update(mainModel(), char('2')).effects).toEqual([])
  })

  /**
   * The pane belongs to the section that filled it (user-journey smoke
   * 2026-09-18, UX-10): on the Journal tab the operator still read
   * `$ mcpcut approvals list` from the Approvals tab until they ran something.
   * Leaving is the operator's own act — unlike the background poll of ADR-0012
   * §21, which must never take an error off the screen by itself.
   */
  test.each([
    ['Tab', key('tab')],
    ['a digit', char('4')],
  ])("%s drops the previous section's output and shows the new section's intro", (_name, msg) => {
    const model = mainModel({ sectionIndex: APPROVALS_TAB, output: panelOf(3) })

    const screen = mainOf(update(model, msg).model)

    expect(screen.output).toBeUndefined()
    expect(screen.pane.kind).toBe('actions')
  })

  test('a digit that names no section leaves the output exactly where it was', () => {
    const model = mainModel({ sectionIndex: APPROVALS_TAB, output: panelOf(3) })

    const step = update(model, char('0'))

    expect(step.model).toBe(model)
  })

  test('an output holding an unsaved one-time token survives a section switch', () => {
    // Navigation is one of the keys the token-hold pane ignores (ADR-0012 §22),
    // so this can only be reached by a pane that is not holding — but the guard
    // is stated here too: losing a token to a keystroke is unrecoverable.
    const held = panelOf(1, { stdout: `${ONE_TIME_TOKEN_MARKER}\nmcpa_secret`, mintsToken: true })
    const model = mainModel({ sectionIndex: APPROVALS_TAB, output: held })

    const screen = mainOf(update(model, key('tab')).model)

    expect(screen.output).toBe(held)
  })
})

describe('update: moving between actions', () => {
  test.each([
    ['down', key('down')],
    ['j', char('j')],
  ])('%s moves to the next action', (_name, msg) => {
    const step = update(mainModel({ sectionIndex: ADMINS_TAB }), msg)

    expect(mainOf(step.model).actionIndex).toBe(1)
  })

  test.each([
    ['up', key('up')],
    ['k', char('k')],
  ])('%s moves to the previous action', (_name, msg) => {
    const step = update(mainModel({ sectionIndex: ADMINS_TAB, actionIndex: 2 }), msg)

    expect(mainOf(step.model).actionIndex).toBe(1)
  })

  test('the cursor stops at the last action instead of wrapping', () => {
    const model = mainModel({ sectionIndex: ADMINS_TAB, actionIndex: 4 })

    const step = update(model, key('down'))

    expect(step.model).toBe(model)
  })

  test('the cursor stops at the first action', () => {
    const model = mainModel({ sectionIndex: ADMINS_TAB })

    const step = update(model, key('up'))

    expect(step.model).toBe(model)
  })

  test('a section index outside the list clamps to the first action rather than dividing by zero', () => {
    const model = mainModel({ sectionIndex: NO_SUCH_TAB, actionIndex: 3 })

    expect(mainOf(update(model, key('down')).model).actionIndex).toBe(0)
    expect(mainOf(update(model, key('up')).model).actionIndex).toBe(0)
  })
})

describe('update: running an action', () => {
  test('Enter on an action with no fields runs it at once', () => {
    const step = update(mainModel({ sectionIndex: ADMINS_TAB }), key('enter'))

    const request: RunRequest = {
      actionId: 'list',
      argv: ['admin', 'list'],
      display: ['admin', 'list'],
    }
    expect(step.effects).toEqual([{ kind: 'run', request }])
    expect(mainOf(step.model).busy).toEqual(request)
    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
  })

  test('Enter on an action with fields opens its form', () => {
    const step = update(mainModel({ sectionIndex: ADMINS_TAB, actionIndex: 1 }), key('enter'))

    const pane = mainOf(step.model).pane
    expect(pane.kind).toBe('form')
    if (pane.kind !== 'form') throw new Error('expected a form pane')
    expect(pane.actionId).toBe('add')
    expect(pane.form.fields.map((field) => field.spec.name)).toEqual(['name', 'role'])
    expect(step.effects).toEqual([])
  })

  test('Enter with the cursor outside the catalogue does nothing', () => {
    const model = mainModel({ sectionIndex: ADMINS_TAB, actionIndex: NO_SUCH_TAB })

    const step = update(model, key('enter'))

    expect(step.model).toBe(model)
    expect(step.effects).toEqual([])
  })

  test('a finished run replaces the output and clears the run in flight', () => {
    const busy: RunRequest = { actionId: 'list', argv: ['admin', 'list'], display: ['admin', 'list'] }
    const result: RunResult = {
      argv: ['admin', 'list'],
      display: ['admin', 'list'],
      exitCode: 0,
      stdout: 'alice owner\n',
      stderr: '',
    }

    const step = update(mainModel({ busy, pane: { kind: 'help' } }), { kind: 'run-result', result })

    const screen = mainOf(step.model)
    expect(screen.output?.lines).toEqual(['alice owner'])
    expect(screen.pane).toEqual({ kind: 'actions' })
    expect('busy' in screen).toBe(false)
    expect(step.effects).toEqual([])
  })

  test('a service answer replaces the header line', () => {
    const statuses: readonly ServiceSummary[] = [
      { service: 'ui', state: 'running', host: '127.0.0.1', port: 8091 },
    ]

    const step = update(mainModel(), { kind: 'services', statuses })

    expect(mainOf(step.model).services).toEqual(statuses)
  })

  test('an unknown service answer leaves the header without a line at all', () => {
    const statuses: readonly ServiceSummary[] = [
      { service: 'ui', state: 'running', host: '127.0.0.1', port: 8091 },
    ]

    const step = update(mainModel({ services: statuses }), { kind: 'services', statuses: undefined })

    expect('services' in mainOf(step.model)).toBe(false)
  })

  test('a sign-in answer is ignored on the main screen', () => {
    const model = mainModel()

    const step = update(model, { kind: 'signin-result', result: { kind: 'ok', name: 'x', role: 'owner' } })

    expect(step.model).toBe(model)
  })

  test('a lost session returns to a fresh sign-in screen that says so', () => {
    const step = update(mainModel({ output: panelOf(3) }), { kind: 'session-lost' })

    const screen = signinOf(step.model)
    expect(screen.notice).toBe(SESSION_LOST_NOTICE)
    expect(screen.busy).toBe(false)
    expect(screen.form.fields[0]?.value).toBe('')
    expect(step.model.size).toEqual(SIZE)
    // The one thing it asks for: the services line that screen draws, which
    // the session that has just gone had answered (F14).
    expect(step.effects).toEqual([{ kind: 'refresh-services' }])
  })
})

describe('update: the r key', () => {
  test('Admins reruns admin list and the service line', () => {
    const step = update(mainModel({ sectionIndex: ADMINS_TAB, actionIndex: 3 }), char('r'))

    const request: RunRequest = {
      actionId: 'list',
      argv: ['admin', 'list'],
      display: ['admin', 'list'],
    }
    expect(step.effects).toEqual([{ kind: 'run', request }, { kind: 'refresh-services' }])
    expect(mainOf(step.model).busy).toEqual(request)
    expect(mainOf(step.model).actionIndex).toBe(3)
  })

  test.each([
    ['Servers', SERVERS_TAB, ['server', 'list']],
    ['Approvals', APPROVALS_TAB, ['approvals', 'list']],
  ])('%s reruns its own list and the service line', (_name, sectionIndex, argv) => {
    const step = update(mainModel({ sectionIndex }), char('r'))

    const request: RunRequest = { actionId: 'list', argv, display: argv }
    expect(step.effects).toEqual([{ kind: 'run', request }, { kind: 'refresh-services' }])
    expect(mainOf(step.model).busy).toEqual(request)
  })

  test('Home reruns status and the service line', () => {
    const step = update(mainModel(), char('r'))

    const request: RunRequest = { actionId: 'status', argv: ['status'], display: ['status'] }
    expect(step.effects).toEqual([{ kind: 'run', request }, { kind: 'refresh-services' }])
  })

  test('a section with no refresh action refreshes only the service line', () => {
    const model = mainModel({ sections: [PLAIN_SECTION] })

    const step = update(model, char('r'))

    expect(step.effects).toEqual([{ kind: 'refresh-services' }])
    expect(step.model).toBe(model)
  })

  test('a section outside the list refreshes only the service line', () => {
    const step = update(mainModel({ sectionIndex: NO_SUCH_TAB }), char('r'))

    expect(step.effects).toEqual([{ kind: 'refresh-services' }])
  })
})
