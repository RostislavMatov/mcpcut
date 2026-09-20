import { describe, expect, test } from 'vitest'
import { NO_COLOR_ENV_VAR, plainStyle, styleFor } from '../../src/tui/ansi.js'
import { MIN_COLUMNS, MIN_ROWS } from '../../src/tui/constants.js'
import { NARROW_COLUMNS, WELCOME_CONNECT_BUSY_TEXT, WELCOME_TITLE } from '../../src/tui/constants-live.js'
import type { KeyEvent } from '../../src/tui/keys.js'
import type { Model, Msg } from '../../src/tui/model.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import { render } from '../../src/tui/render.js'
import { update } from '../../src/tui/update.js'
import { welcomeModel } from '../../src/tui/update-welcome.js'
import { wizardScreenOf, type WizardPrefill } from '../../src/tui/wizard-fields.js'

/** The welcome screen as frames: exactly the terminal, at any size, in any style. */

function key(event: KeyEvent): Msg {
  return { kind: 'key', key: event }
}

function wizardOf() {
  const prefill: WizardPrefill = {
    mode: 'first-run',
    configPath: '/home/op/.mcpcut/config.json',
    config: defaultInstallConfig('/home/op/.mcpcut/data'),
  }
  return wizardScreenOf(prefill)
}

function modelAt(columns: number, rows: number): Model {
  return welcomeModel({ columns, rows }, wizardOf())
}

function frameOf(model: Model, style = plainStyle): readonly string[] {
  return render(model, style)
}

describe('render: the welcome screen — choosing', () => {
  test('names both options and fills the terminal exactly, at 80x24', () => {
    const frame = frameOf(modelAt(80, 24))

    expect(frame).toHaveLength(24)
    expect(frame.every((line) => line.length === 80)).toBe(true)
    const text = frame.join('\n')
    expect(text).toContain(WELCOME_TITLE)
    expect(text).toContain('Set up a service on this machine')
    expect(text).toContain('Connect to a service on another host')
  })

  test('marks the highlighted option and only that one', () => {
    const text = frameOf(modelAt(80, 24)).join('\n')

    expect(text).toContain('▸ Set up a service on this machine')
    expect(text).toContain('  Connect to a service on another host')
  })

  test('draws correctly below the narrow-layout threshold and at the smallest supported size', () => {
    for (const [columns, rows] of [
      [NARROW_COLUMNS - 1, 24],
      [MIN_COLUMNS, MIN_ROWS],
    ] as const) {
      const frame = frameOf(modelAt(columns, rows))
      expect(frame).toHaveLength(rows)
      expect(frame.every((line) => line.length === columns)).toBe(true)
    }
  })

  test('under NO_COLOR the frame carries no escape byte', () => {
    const style = styleFor({ [NO_COLOR_ENV_VAR]: '1' })
    const frame = frameOf(modelAt(80, 24), style)

    expect(frame.join('\n')).not.toContain('\x1b')
  })
})

describe('render: the welcome screen — connecting', () => {
  function connectModel(): Model {
    return update(modelAt(80, 24), key({ kind: 'char', char: '2' })).model
  }

  test('shows the form and the focused field caret', () => {
    const text = frameOf(connectModel()).join('\n')

    expect(text).toContain('Host:')
    expect(text).toContain('Port:')
    expect(text).toContain('Protocol: https')
  })

  test('while a probe is out the block says so', () => {
    const withHost = [...'box.example'].reduce(
      (model, char) => update(model, key({ kind: 'char', char })).model,
      connectModel(),
    )
    const withPort = [...'8091'].reduce(
      (model, char) => update(model, key({ kind: 'char', char })).model,
      update(withHost, key({ kind: 'tab' })).model,
    )
    const busy = update(withPort, key({ kind: 'enter' })).model

    expect(frameOf(busy).join('\n')).toContain(WELCOME_CONNECT_BUSY_TEXT)
  })

  test('an unfilled submission (empty host) is refused and stays off the busy text', () => {
    const refused = update(connectModel(), key({ kind: 'enter' })).model

    expect(frameOf(refused).join('\n')).not.toContain(WELCOME_CONNECT_BUSY_TEXT)
  })

  test('a refused submission shows the notice under the form, sanitised', () => {
    const withHost = [...'ftp://box.example'].reduce(
      (model, char) => update(model, key({ kind: 'char', char })).model,
      connectModel(),
    )
    const refused = update(withHost, key({ kind: 'enter' })).model

    const text = frameOf(refused).join('\n')
    expect(text).toContain('http://')
  })

  test('escape bytes typed into a field never reach a frame', () => {
    const typed = [...'a\x1b[31mb'].reduce(
      (model, char) => update(model, key({ kind: 'char', char })).model,
      connectModel(),
    )

    expect(frameOf(typed).join('\n')).not.toContain('\x1b')
  })
})
