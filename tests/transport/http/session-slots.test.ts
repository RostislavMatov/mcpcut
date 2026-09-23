import { describe, expect, test } from 'vitest'
import { createSlotCounter } from '../../../src/transport/http/session-slots.js'

/**
 * The concurrency cap as reservations, with a way to make room (RS7): an idle
 * warm server outside the manager's view may give its slot to a new session.
 */

describe('createSlotCounter', () => {
  test('reserves while there is room, and refuses at the cap', () => {
    const slots = createSlotCounter(2, () => 0)

    expect(slots.reserve()).not.toBeNull()
    expect(slots.reserve()).not.toBeNull()
    expect(slots.reserve()).toBeNull()
  })

  test('a full budget asks `reclaim`, and a freed slot is taken', () => {
    // Arrange
    let outside = 2
    const slots = createSlotCounter(2, () => outside, () => {
      outside -= 1
      return true
    })

    // Act
    const slot = slots.reserve()

    // Assert
    expect(slot).not.toBeNull()
    expect(slots.reserved()).toBe(1)
  })

  test('`reclaim` that frees nothing leaves the refusal', () => {
    const slots = createSlotCounter(1, () => 1, () => false)

    expect(slots.reserve()).toBeNull()
  })

  test('`reclaim` that says it freed a slot but did not is not believed', () => {
    const slots = createSlotCounter(1, () => 1, () => true)

    expect(slots.reserve()).toBeNull()
  })

  test('`reclaim` is not asked while there is room', () => {
    let asked = 0
    const slots = createSlotCounter(2, () => 0, () => {
      asked += 1
      return true
    })

    slots.reserve()

    expect(asked).toBe(0)
  })

  test('without `reclaim` it behaves as before', () => {
    const slots = createSlotCounter(1, () => 0)
    const slot = slots.reserve()

    expect(slots.reserve()).toBeNull()
    slot?.release()
    slot?.release()
    expect(slots.reserve()).not.toBeNull()
  })
})
