import { describe, expect, test } from 'vitest'
import { plainStyle } from '../../src/tui/ansi.js'
import type { KeyEvent } from '../../src/tui/keys.js'
import type { Model, Msg } from '../../src/tui/model.js'
import { parseRemoteUrl } from '../../src/tui/remote/url.js'
import { render } from '../../src/tui/render.js'
import { update } from '../../src/tui/update.js'
import { welcomeConnectModel, welcomeModel, type ConnectEntry } from '../../src/tui/update-welcome.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import { wizardScreenOf } from '../../src/tui/wizard-fields.js'

/**
 * Esc from the connect form goes back to THIS machine's console when there is
 * one (2026-09-28): a local console's Ctrl-O and Home ▸ connect reopen on
 * `--connect`, and a form that could only be left by quitting the program
 * made that a one-way door. Esc reopens a bare `mcpcut` — the local install
 * wins the bare-launch precedence — and the footer says so. Without a local
 * install ("choose" ▸ Connect) Esc still goes back to "choose".
 */

const SIZE = { columns: 80, rows: 24 }
const LOCAL: ConnectEntry = { escapesToChoose: false, escapesToLocal: true }
const BACK_TO_LOCAL = { kind: 'reopen', argv: [] }
const BACK_HINT = 'Esc back to this machine'

function key(event: KeyEvent): Msg {
  return { kind: 'key', key: event }
}

function wizardOf() {
  return wizardScreenOf({
    mode: 'first-run',
    configPath: '/home/op/.mcpcut/config.json',
    config: defaultInstallConfig('/home/op/.mcpcut/data'),
  })
}

function footerOf(model: Model): string {
  return render(model, plainStyle).at(-1) ?? ''
}

function urlOf(raw: string) {
  const parsed = parseRemoteUrl(raw)
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.url
}

describe('connect form over a machine with a local install', () => {
  test('Esc reopens a bare mcpcut: back to the local console, not out of the program', () => {
    const model = welcomeConnectModel(SIZE, wizardOf(), LOCAL)

    const step = update(model, key({ kind: 'escape' }))

    expect(step.effects).toEqual([BACK_TO_LOCAL])
  })

  test('the way back survives an edit and a failed probe', () => {
    const edited = update(welcomeConnectModel(SIZE, wizardOf(), { ...LOCAL, url: urlOf('https://box.example:8091') }), key({ kind: 'char', char: 'x' })).model
    const busy = update(edited, key({ kind: 'backspace' })).model
    const probing = update(busy, key({ kind: 'enter' })).model
    const failed = update(probing, {
      kind: 'connect-probe-result',
      url: 'https://box.example:8091',
      result: { ok: false, message: 'refused' },
    }).model

    expect(update(edited, key({ kind: 'escape' })).effects).toEqual([BACK_TO_LOCAL])
    expect(update(failed, key({ kind: 'escape' })).effects).toEqual([BACK_TO_LOCAL])
  })

  test('Esc is ignored while a probe is out, like every other key', () => {
    const probing = update(welcomeConnectModel(SIZE, wizardOf(), { ...LOCAL, url: urlOf('https://box.example:8091') }), key({ kind: 'enter' })).model

    expect(update(probing, key({ kind: 'escape' })).effects).toEqual([])
  })

  test('the footer says where Esc goes', () => {
    expect(footerOf(welcomeConnectModel(SIZE, wizardOf(), LOCAL))).toContain(BACK_HINT)
  })
})

describe('connect form with no local install', () => {
  test('Esc still goes back to "choose", and the footer does not promise this machine', () => {
    const chosen = update(welcomeModel(SIZE, wizardOf()), key({ kind: 'char', char: '2' })).model

    const step = update(chosen, key({ kind: 'escape' }))

    expect(step.effects).toEqual([])
    expect(step.model.screen).toMatchObject({ kind: 'welcome', stage: { kind: 'choose' } })
    expect(footerOf(chosen)).not.toContain(BACK_HINT)
  })
})
