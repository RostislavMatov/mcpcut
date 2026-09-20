import { describe, expect, test } from 'vitest'
import type { KeyEvent } from '../../src/tui/keys.js'
import type { Model, Msg, Step } from '../../src/tui/model.js'
import { parseRemoteUrl } from '../../src/tui/remote/url.js'
import { update } from '../../src/tui/update.js'
import { welcomeConnectModel, welcomeModel } from '../../src/tui/update-welcome.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import { wizardScreenOf, type WizardPrefill } from '../../src/tui/wizard-fields.js'

/**
 * The welcome screen (2026-09-19): what a bare `mcpcut` opens on over an
 * install nothing has configured yet — choose between the wizard already
 * tested elsewhere, and a small "connect" form that shares its one validator
 * with `--remote` (`welcome-connect.test.ts`).
 */

const SIZE = { columns: 80, rows: 24 }

function key(event: KeyEvent): Msg {
  return { kind: 'key', key: event }
}

function typed(model: Model, text: string): Model {
  return [...text].reduce((next, char) => update(next, key({ kind: 'char', char })).model, model)
}

/** The prebuilt wizard screen the welcome model is opened with, in every test. */
function wizardOf() {
  const prefill: WizardPrefill = {
    mode: 'first-run',
    configPath: '/home/op/.mcpcut/config.json',
    config: defaultInstallConfig('/home/op/.mcpcut/data'),
  }
  return wizardScreenOf(prefill)
}

function freshModel(): Model {
  return welcomeModel(SIZE, wizardOf())
}

describe('welcome: choosing', () => {
  test('opens on the first option, with neither chosen yet', () => {
    const screen = freshModel().screen
    expect(screen).toMatchObject({ kind: 'welcome', stage: { kind: 'choose', index: 0 } })
  })

  test('down/up (and j/k) move the highlighted option, wrapping at both ends', () => {
    const model = freshModel()

    const down = update(model, key({ kind: 'down' })).model
    expect(down.screen).toMatchObject({ stage: { kind: 'choose', index: 1 } })

    const wrapped = update(down, key({ kind: 'down' })).model
    expect(wrapped.screen).toMatchObject({ stage: { kind: 'choose', index: 0 } })

    const viaJ = update(model, key({ kind: 'char', char: 'j' })).model
    expect(viaJ.screen).toMatchObject({ stage: { kind: 'choose', index: 1 } })

    const viaK = update(viaJ, key({ kind: 'char', char: 'k' })).model
    expect(viaK.screen).toMatchObject({ stage: { kind: 'choose', index: 0 } })
  })

  test('Enter on the first option swaps straight to the prebuilt wizard screen', () => {
    const model = freshModel()
    const wizard = model.screen.kind === 'welcome' ? model.screen.wizard : undefined

    const step = update(model, key({ kind: 'enter' }))

    expect(step.model.screen).toBe(wizard)
    expect(step.effects).toEqual([])
  })

  test('"1" selects "set up" directly, without needing Enter first', () => {
    const model = freshModel()
    const wizard = model.screen.kind === 'welcome' ? model.screen.wizard : undefined

    const step = update(model, key({ kind: 'char', char: '1' }))

    expect(step.model.screen).toBe(wizard)
  })

  test('"2" selects "connect" directly and opens its form', () => {
    const step = update(freshModel(), key({ kind: 'char', char: '2' }))

    expect(step.model.screen).toMatchObject({ kind: 'welcome', stage: { kind: 'connect', busy: false } })
  })

  test('moving to the second option then Enter opens the connect form', () => {
    const moved = update(freshModel(), key({ kind: 'down' })).model
    const step = update(moved, key({ kind: 'enter' }))

    expect(step.model.screen).toMatchObject({ kind: 'welcome', stage: { kind: 'connect' } })
  })

  test('Esc quits with EXIT_OK', () => {
    expect(update(freshModel(), key({ kind: 'escape' })).effects).toEqual([{ kind: 'quit', exitCode: 0 }])
  })

  test('q quits with EXIT_OK', () => {
    expect(update(freshModel(), key({ kind: 'char', char: 'q' })).effects).toEqual([
      { kind: 'quit', exitCode: 0 },
    ])
  })
})

describe('welcome: the connect form', () => {
  function connectModel(): Model {
    return update(freshModel(), key({ kind: 'char', char: '2' })).model
  }

  function submitted(host: string, port: string): Step {
    const withHost = typed(connectModel(), host)
    const withPort = typed(update(withHost, key({ kind: 'tab' })).model, port)
    return update(withPort, key({ kind: 'enter' }))
  }

  test('Enter with a good host and port goes busy and asks for a probe', () => {
    const step = submitted('box.example', '8091')

    expect(step.effects).toEqual([{ kind: 'connect-probe', url: 'https://box.example:8091' }])
    expect(step.model.screen).toMatchObject({ stage: { kind: 'connect', busy: true } })
  })

  test('a second Enter while busy does nothing: busy is checked before anything else', () => {
    const busy = submitted('box.example', '8091').model

    const step = update(busy, key({ kind: 'enter' }))

    expect(step.effects).toEqual([])
    expect(step.model).toEqual(busy)
  })

  test('Esc while busy does NOT leave the form: the probe in flight is a request already sent', () => {
    const busy = submitted('box.example', '8091').model

    const step = update(busy, key({ kind: 'escape' }))

    expect(step.effects).toEqual([])
    expect(step.model).toEqual(busy)
  })

  test('Esc when not busy goes back to "choose", on the connect option', () => {
    const step = update(connectModel(), key({ kind: 'escape' }))

    expect(step.model.screen).toMatchObject({ kind: 'welcome', stage: { kind: 'choose', index: 1 } })
  })

  test('an empty host is refused on the host field and nothing is dispatched', () => {
    const step = submitted('', '8091')

    expect(step.effects).toEqual([])
    const screen = step.model.screen
    expect(screen.kind === 'welcome' && screen.stage.kind === 'connect' && screen.stage.form.fields[0]?.error).toBe(
      'required',
    )
  })

  test('a bad port is refused on the port field', () => {
    const step = submitted('box.example', '999999')

    expect(step.effects).toEqual([])
    const screen = step.model.screen
    expect(
      screen.kind === 'welcome' &&
        screen.stage.kind === 'connect' &&
        screen.stage.form.fields.find((field) => field.spec.name === 'port')?.error,
    ).toBe('expected 1..65535')
  })

  test('a whole URL pasted into Host needs no port and is refused by the same wording as --remote', () => {
    const step = submitted('ftp://box.example', '')

    expect(step.effects).toEqual([])
    const screen = step.model.screen
    expect(screen.kind === 'welcome' && screen.stage.kind === 'connect' && screen.stage.notice).toContain('http://')
  })

  test('editing a field after a refusal clears the notice', () => {
    const refused = submitted('ftp://box.example', '').model
    const edited = typed(refused, 'x')

    const screen = edited.screen
    expect(screen.kind === 'welcome' && screen.stage.kind === 'connect' && screen.stage.notice).toBeUndefined()
  })
})

describe('welcome: the probe answer', () => {
  function busyModel(): Model {
    const connect = update(freshModel(), key({ kind: 'char', char: '2' })).model
    const withHost = typed(connect, 'box.example')
    const withPort = typed(update(withHost, key({ kind: 'tab' })).model, '8091')
    return update(withPort, key({ kind: 'enter' })).model
  }

  test('success reopens with ["--remote", url] and touches nothing else', () => {
    const msg: Msg = {
      kind: 'connect-probe-result',
      url: 'https://box.example:8091',
      result: { ok: true },
    }
    const step = update(busyModel(), msg)

    expect(step.effects).toEqual([{ kind: 'reopen', argv: ['--remote', 'https://box.example:8091'] }])
  })

  test('failure returns to the form, values kept, with a notice', () => {
    const busy = busyModel()
    const msg: Msg = {
      kind: 'connect-probe-result',
      url: 'https://box.example:8091',
      result: { ok: false, message: 'could not reach the remote console: refused' },
    }

    const step = update(busy, msg)

    const screen = step.model.screen
    expect(step.effects).toEqual([])
    expect(screen.kind === 'welcome' && screen.stage.kind === 'connect' && screen.stage.busy).toBe(false)
    expect(screen.kind === 'welcome' && screen.stage.kind === 'connect' && screen.stage.notice).toContain('refused')
    expect(
      screen.kind === 'welcome' &&
        screen.stage.kind === 'connect' &&
        screen.stage.form.fields.find((field) => field.spec.name === 'host')?.value,
    ).toBe('box.example')
  })

  test('a failed https attempt appends the plain-http hint', () => {
    const step = update(busyModel(), {
      kind: 'connect-probe-result',
      url: 'https://box.example:8091',
      result: { ok: false, message: 'could not reach the remote console: refused' },
    })

    const screen = step.model.screen
    expect(screen.kind === 'welcome' && screen.stage.kind === 'connect' && screen.stage.notice).toContain('http')
  })

  test('a failed http attempt does not append the https hint', () => {
    const step = update(busyModel(), {
      kind: 'connect-probe-result',
      url: 'http://box.example:8091',
      result: { ok: false, message: 'could not reach the remote console: refused' },
    })

    const screen = step.model.screen
    const notice = screen.kind === 'welcome' && screen.stage.kind === 'connect' ? screen.stage.notice : undefined
    expect(notice).toBe('could not reach the remote console: refused')
  })
})

/**
 * `welcomeConnectModel` (2026-09-20): `mcpcut --connect [url]`, and a bare
 * `mcpcut` whose saved address did not answer — both open straight on the
 * connect stage, never on "choose".
 */
describe('welcomeConnectModel: opening straight on the connect stage', () => {
  function urlOf(raw: string) {
    const result = parseRemoteUrl(raw)
    if (!result.ok) throw new Error('test fixture')
    return result.url
  }

  test('with no url at all, opens an empty form, not busy, no notice', () => {
    const model = welcomeConnectModel(SIZE, wizardOf())

    expect(model.screen).toMatchObject({ kind: 'welcome', stage: { kind: 'connect', busy: false } })
    const screen = model.screen
    expect(screen.kind === 'welcome' && screen.stage.kind === 'connect' && screen.stage.notice).toBeUndefined()
    expect(
      screen.kind === 'welcome' &&
        screen.stage.kind === 'connect' &&
        screen.stage.form.fields.find((field) => field.spec.name === 'host')?.value,
    ).toBe('')
  })

  test('with a url, the form is prefilled from it', () => {
    const model = welcomeConnectModel(SIZE, wizardOf(), { url: urlOf('https://box.example:8091') })

    const screen = model.screen
    expect(
      screen.kind === 'welcome' &&
        screen.stage.kind === 'connect' &&
        screen.stage.form.fields.map((field) => field.value),
    ).toEqual(['box.example', '8091', 'https'])
  })

  test('an invalid --connect argument prefills only Host with the raw text, via hostText', () => {
    const model = welcomeConnectModel(SIZE, wizardOf(), { hostText: 'not a url', notice: 'not a URL' })

    const screen = model.screen
    expect(
      screen.kind === 'welcome' &&
        screen.stage.kind === 'connect' &&
        screen.stage.form.fields.find((field) => field.spec.name === 'host')?.value,
    ).toBe('not a url')
    expect(screen.kind === 'welcome' && screen.stage.kind === 'connect' && screen.stage.notice).toBe('not a URL')
  })

  test('a notice rides along, e.g. "the saved service did not answer"', () => {
    const model = welcomeConnectModel(SIZE, wizardOf(), { notice: 'could not reach it' })

    const screen = model.screen
    expect(screen.kind === 'welcome' && screen.stage.kind === 'connect' && screen.stage.notice).toBe(
      'could not reach it',
    )
  })

  test('by default, Esc goes back to "choose" — the ordinary rule', () => {
    const model = welcomeConnectModel(SIZE, wizardOf())

    const step = update(model, key({ kind: 'escape' }))

    expect(step.model.screen).toMatchObject({ kind: 'welcome', stage: { kind: 'choose' } })
    expect(step.effects).toEqual([])
  })

  test('escapesToChoose: false quits instead: an install already exists, "choose" has no honest fallback', () => {
    const model = welcomeConnectModel(SIZE, wizardOf(), { escapesToChoose: false })

    const step = update(model, key({ kind: 'escape' }))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: 0 }])
  })

  test('escapesToChoose: false survives an edit on the form', () => {
    const model = welcomeConnectModel(SIZE, wizardOf(), { escapesToChoose: false })

    const edited = typed(model, 'x')
    const step = update(edited, key({ kind: 'escape' }))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: 0 }])
  })

  test('escapesToChoose: false survives a failed probe, back on the form', () => {
    const busy = update(
      welcomeConnectModel(SIZE, wizardOf(), {
        url: urlOf('https://box.example:8091'),
        escapesToChoose: false,
      }),
      key({ kind: 'enter' }),
    ).model

    const afterFailure = update(busy, {
      kind: 'connect-probe-result',
      url: 'https://box.example:8091',
      result: { ok: false, message: 'refused' },
    }).model

    const step = update(afterFailure, key({ kind: 'escape' }))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: 0 }])
  })
})
