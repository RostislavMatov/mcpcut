import { describe, expect, test } from 'vitest'
import {
  createCell,
  createReopenCell,
  createTokenCell,
  createWizardOutcomeCell,
} from '../../src/tui/cells.js'

/**
 * The runtime's deliberately mutable cells (phase 5, task 1): one closure per
 * answer an effect has to hand back out of band. They are asserted here rather
 * than only through the effects that write them, because the whole point of
 * the shape is that the value is reachable through `get` alone — nothing can
 * enumerate, clone or serialize it by accident.
 */

describe('createCell', () => {
  test('starts empty, holds what it is given, and lets go again', () => {
    const cell = createCell<string>()

    expect(cell.get()).toBeUndefined()
    cell.set('kept')
    expect(cell.get()).toBe('kept')
    cell.set(undefined)
    expect(cell.get()).toBeUndefined()
  })

  test('two cells are independent, so one console cannot read another one', () => {
    const first = createCell<string>()
    const second = createCell<string>()

    first.set('first')

    expect(second.get()).toBeUndefined()
  })

  test('the value is not a property of the cell object', () => {
    const cell = createCell<string>()
    cell.set('secret')

    expect(Object.values(cell)).not.toContain('secret')
    expect(JSON.stringify(cell)).not.toContain('secret')
  })
})

describe('the three named cells', () => {
  test('the token cell is an empty cell of the token string', () => {
    const cell = createTokenCell()
    cell.set('mcpa_abc')

    expect(cell.get()).toBe('mcpa_abc')
  })

  test("the wizard's cell holds the one outcome it can ask for", () => {
    const cell = createWizardOutcomeCell()
    cell.set('sign-in')

    expect(cell.get()).toBe('sign-in')
  })

  test('the reopen cell holds the argv the console is to be reopened with', () => {
    const cell = createReopenCell()
    cell.set(['setup'])

    expect(cell.get()).toEqual(['setup'])
  })
})
