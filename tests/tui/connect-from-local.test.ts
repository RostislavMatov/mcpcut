import { describe, expect, test } from 'vitest'
import { plainStyle } from '../../src/tui/ansi.js'
import { HOME_SECTION } from '../../src/tui/catalogue/home.js'
import type { KeyEvent } from '../../src/tui/keys.js'
import { initialModel, type InstallFacts, type Model, type Msg } from '../../src/tui/model.js'
import { render } from '../../src/tui/render.js'
import { update } from '../../src/tui/update.js'
import { firstOwnerModel } from '../../src/tui/update-first-owner.js'
import { HOME_TAB, key, mainModel, mainOf } from './support/update-fixtures.js'

/**
 * "Connect to another service" from INSIDE a local console (2026-09-28, owner
 * complaint: on a machine with a local install there was nowhere to type a
 * remote address without knowing the `--connect` flag). Two ways in, one
 * effect: Ctrl-O on the local sign-in and first-owner screens, and Home ▸
 * connect once signed in — each reopens on `mcpcut --connect`, whose form is
 * prefilled from the remembered address when there is one (`tui-cmd`'s job,
 * `tests/cli/tui-cmd-connect-entry.test.ts`).
 */

const SIZE = { columns: 80, rows: 24 }
const REMOTE: InstallFacts = { supervisor: 'mcpcut', remote: true, remoteAddress: 'https://box.example:8091' }
const CTRL_O: KeyEvent = { kind: 'ctrl', char: 'o' }
const CONNECT_REOPEN = { kind: 'reopen', argv: ['--connect'] }
const HINT_KEY = 'Ctrl-O'

function press(event: KeyEvent): Msg {
  return { kind: 'key', key: event }
}

function typed(model: Model, text: string): Model {
  return [...text].reduce((next: Model, char) => update(next, press({ kind: 'char', char })).model, model)
}

function lastLine(model: Model): string {
  return render(model, plainStyle).at(-1) ?? ''
}

describe('sign-in of a local install: Ctrl-O connects to another service', () => {
  test('reopens on --connect with no address: the form opens empty or on the remembered one', () => {
    const model = initialModel(SIZE)

    const step = update(model, press(CTRL_O))

    expect(step.effects).toEqual([CONNECT_REOPEN])
  })

  test('is ignored while a sign-in is in flight: the token was already sent', () => {
    const submitted = update(typed(initialModel(SIZE), 'mcpa_x'), press({ kind: 'enter' })).model

    const step = update(submitted, press(CTRL_O))

    expect(step.effects).toEqual([])
    expect(step.model).toEqual(submitted)
  })

  test('does nothing on a remote console, where Ctrl-D is the way to another service', () => {
    const model = initialModel(SIZE, REMOTE)

    const step = update(model, press(CTRL_O))

    expect(step.effects).toEqual([])
    expect(step.model).toEqual(model)
  })

  test('the footer names the key locally, and only locally', () => {
    expect(lastLine(initialModel(SIZE))).toContain(`${HINT_KEY} connect to another service`)
    expect(lastLine(initialModel(SIZE, REMOTE))).not.toContain(HINT_KEY)
  })
})

describe('first-owner screen of a local install: Ctrl-O connects to another service', () => {
  test('reopens on --connect from the name form', () => {
    const step = update(firstOwnerModel(SIZE), press(CTRL_O))

    expect(step.effects).toEqual([CONNECT_REOPEN])
  })

  test('is ignored while the owner is being created: its token must reach the screen', () => {
    const busy = update(typed(firstOwnerModel(SIZE), 'alice'), press({ kind: 'enter' })).model

    const step = update(busy, press(CTRL_O))

    expect(step.effects).toEqual([])
    expect(step.model).toEqual(busy)
  })

  test('is ignored while the one-time token is held on screen', () => {
    const busy = update(typed(firstOwnerModel(SIZE), 'alice'), press({ kind: 'enter' })).model
    const held = update(busy, {
      kind: 'first-owner-result',
      result: { argv: [], display: [], exitCode: 0, stdout: 'admin: alice\nrole: owner\ntoken: mcpa_t\n', stderr: '' },
    }).model

    const step = update(held, press(CTRL_O))

    expect(step.effects).toEqual([])
  })

  test('does nothing on a remote console', () => {
    const model = firstOwnerModel(SIZE, REMOTE)

    expect(update(model, press(CTRL_O)).effects).toEqual([])
  })

  test('the form footer names the key locally, and only locally', () => {
    expect(lastLine(firstOwnerModel(SIZE))).toContain(`${HINT_KEY} connect to another service`)
    expect(lastLine(firstOwnerModel(SIZE, REMOTE))).not.toContain(HINT_KEY)
  })
})

describe('Home ▸ connect', () => {
  test('is offered on a local console, after status', () => {
    const home = mainOf(mainModel({ sectionIndex: HOME_TAB }, 'viewer')).sections[HOME_TAB]

    expect(home?.actions.map((action) => action.id)).toEqual(['status', 'connect'])
  })

  test('is not offered on a remote console, which has disconnect instead', () => {
    const home = mainOf(mainModel({ sectionIndex: HOME_TAB }, 'owner', REMOTE)).sections[HOME_TAB]

    expect(home?.actions.map((action) => action.id)).toEqual(['status', 'disconnect'])
  })

  test('says what it does', () => {
    const connect = HOME_SECTION.actions.find((action) => action.id === 'connect')

    expect(connect?.hint).toBe('Connect this console to a service on another host')
  })

  test('Enter reopens on --connect at once — no question, nothing running', () => {
    const model = mainModel({ sectionIndex: HOME_TAB, actionIndex: 1 }, 'viewer')

    const step = update(model, key('enter'))

    expect(step.effects).toEqual([CONNECT_REOPEN])
    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
    expect(mainOf(step.model).busy).toBeUndefined()
  })
})
