import { describe, expect, test } from 'vitest'
import type { KeyEvent } from '../../src/tui/keys.js'
import { initialModel, type InstallFacts, type Model, type Msg } from '../../src/tui/model.js'
import { update } from '../../src/tui/update.js'

/**
 * Ctrl-D on the sign-in screen (2026-09-20, owner request "a way to
 * disconnect"): remote-only, and never while a sign-in is already in flight.
 * Locally the chord is exactly what it has always been — nothing.
 */

const SIZE = { columns: 80, rows: 24 }
const REMOTE: InstallFacts = { supervisor: 'mcpcut', remote: true, remoteAddress: 'https://box.example:8091' }
const CTRL_D: KeyEvent = { kind: 'ctrl', char: 'd' }

function key(event: KeyEvent): Msg {
  return { kind: 'key', key: event }
}

describe('sign-in: Ctrl-D disconnects a remote console', () => {
  test('forgets nothing itself but asks the runtime to disconnect, reopening on --connect <address>', () => {
    const model = initialModel(SIZE, REMOTE)

    const step = update(model, key(CTRL_D))

    expect(step.effects).toEqual([{ kind: 'disconnect', argv: ['--connect', 'https://box.example:8091'] }])
  })

  test('does nothing on a local console: the chord is not remote-aware locally', () => {
    const model = initialModel(SIZE)

    const step = update(model, key(CTRL_D))

    expect(step.effects).toEqual([])
    expect(step.model).toEqual(model)
  })

  test('is ignored while a sign-in is already in flight: the request was already sent', () => {
    const model = initialModel(SIZE, REMOTE)
    const busy = [...'mcpa_x'].reduce(
      (next: Model, char) => update(next, key({ kind: 'char', char })).model,
      model,
    )
    const submitted = update(busy, key({ kind: 'enter' })).model

    const step = update(submitted, key(CTRL_D))

    expect(step.effects).toEqual([])
    expect(step.model).toEqual(submitted)
  })

  test('an absent remoteAddress (a wiring fault) reopens on an empty address rather than crashing', () => {
    const model = initialModel(SIZE, { supervisor: 'mcpcut', remote: true })

    const step = update(model, key(CTRL_D))

    expect(step.effects).toEqual([{ kind: 'disconnect', argv: ['--connect', ''] }])
  })
})
