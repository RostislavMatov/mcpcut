import { describe, expect, test } from 'vitest'
import type { KeyEvent } from '../../src/tui/keys.js'
import { mainScreenOf, type MainScreen, type Session } from '../../src/tui/model.js'
import { fieldsOf, mainOf, withMain } from '../../src/tui/update-step.js'

/**
 * The record `mainOf` rebuilds a main screen from (phase 6, Task 3): every
 * optional field of the screen has to travel through `fieldsOf` and back, and
 * an absent one has to stay ABSENT — `exactOptionalPropertyTypes` makes
 * `pendingKeys: undefined` a different screen from one without the key, and
 * `toEqual` would not tell them apart.
 */

const SESSION: Session = { adminName: 'root', role: 'owner' }

function mainScreen(): MainScreen {
  return mainScreenOf(SESSION, []) as MainScreen
}

const ENTER: KeyEvent = { kind: 'enter' } as KeyEvent
const Q: KeyEvent = { kind: 'char', char: 'q' } as KeyEvent

describe('pendingKeys through fieldsOf and mainOf', () => {
  test('a screen without pendingKeys comes back without the key at all', () => {
    const screen = mainScreen()

    const rebuilt = mainOf(fieldsOf(screen))

    expect(rebuilt).toEqual(screen)
    expect('pendingKeys' in rebuilt).toBe(false)
    expect(fieldsOf(screen).pendingKeys).toBeUndefined()
  })

  test('a screen with pendingKeys carries them through, oldest first, by reference', () => {
    const pendingKeys: readonly KeyEvent[] = [ENTER, Q]
    const screen: MainScreen = { ...mainScreen(), pendingKeys }

    const rebuilt = mainOf(fieldsOf(screen))

    expect(rebuilt.pendingKeys).toBe(pendingKeys)
    expect(rebuilt).toEqual(screen)
  })

  test('withMain sets the buffer, and setting it to undefined removes the key', () => {
    const model = { screen: mainScreen(), size: { columns: 80, rows: 24 } }

    const held = withMain(model, model.screen, { pendingKeys: [ENTER] }).model
    const heldScreen = held.screen as MainScreen
    const cleared = withMain(held, heldScreen, { pendingKeys: undefined }).model

    expect(heldScreen.pendingKeys).toEqual([ENTER])
    expect('pendingKeys' in cleared.screen).toBe(false)
    expect(held.screen).not.toBe(model.screen)
  })
})
