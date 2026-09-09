import { describe, expect, test } from 'vitest'
import {
  ACTION_COLUMN_WIDTH,
  ACTIVE_MARKER,
  FOOTER_ROWS,
  HEADER_ROWS,
} from '../../../src/tui/constants.js'
import {
  actionTitlesIn,
  activeActionIndexIn,
  CONSOLE_ROWS,
  settledWithin,
} from './console-harness.js'

/**
 * The three console-harness helpers whose failure mode is silence.
 *
 * They are test support, and tested anyway for the reason `wizard-harness.test`
 * gives about its ports: each of these can be WRONG without anything saying
 * so, and the symptom lands somewhere else.
 *
 * `actionTitlesIn` and `activeActionIndexIn` slice a drawn frame by index —
 * `HEADER_ROWS` down, `ACTIVE_MARKER.length` in, `ACTION_COLUMN_WIDTH` across.
 * Move any of those and the readers quietly return `[]` and `-1`; the suites
 * then report "timed out waiting for the servers section", which reads as a
 * console that hangs rather than a harness that cannot see.
 *
 * `settledWithin` is what `close()` leans on. It must ANSWER rather than
 * throw, whichever way the console's promise went — a rejection escaping it
 * would fail the `afterEach` of whatever test happened to be last.
 */

/** Rows of a drawn frame the action column occupies. */
const BODY_ROWS = CONSOLE_ROWS - HEADER_ROWS - FOOTER_ROWS

/** A hang would be the bug; anything the helpers do should take milliseconds. */
const HELPER_TIMEOUT_MS = 2_000

/** Well under `HELPER_TIMEOUT_MS`, and long enough not to race the event loop. */
const DEADLINE_MS = 50

/**
 * A frame shaped like the console's: a header band, an action column beside a
 * pane, and a footer. `activeIndex` is the row the cursor marker is on, or
 * `-1` for a frame with no cursor at all (the sign-in screen has none).
 */
function frameOf(titles: readonly string[], activeIndex: number): string {
  const header = Array.from({ length: HEADER_ROWS }, (_unused, row) => `header ${row}`)
  const body = Array.from({ length: BODY_ROWS }, (_unused, row) => {
    const title = titles[row] ?? ''
    const marker = row === activeIndex ? ACTIVE_MARKER : ' '.repeat(ACTIVE_MARKER.length)
    const column = `${marker}${title}`.padEnd(ACTION_COLUMN_WIDTH)
    return `${column}  pane row ${row}`
  })
  const footer = Array.from({ length: FOOTER_ROWS }, () => 'footer')

  return [...header, ...body, ...footer].join('\n')
}

describe('reading the action column of a frame', () => {
  test('returns the titles beside the marker, header and footer bands excluded', () => {
    // Arrange
    const frame = frameOf(['list', 'show', 'add'], 0)

    // Act
    const titles = actionTitlesIn(frame)

    // Assert: not `header 0`, not `footer`, and not the marker's own columns.
    expect(titles).toEqual(['list', 'show', 'add'])
  })

  test('a title is read without the pane text sharing its row', () => {
    expect(actionTitlesIn(frameOf(['refresh'], 0))).toEqual(['refresh'])
  })

  test('names the row the cursor marker is on, by position among the titles', () => {
    expect(activeActionIndexIn(frameOf(['list', 'show', 'add'], 2))).toBe(2)
  })

  test('answers -1 for a frame drawing no cursor at all', () => {
    expect(activeActionIndexIn(frameOf(['list', 'show'], -1))).toBe(-1)
  })

  test('an empty column reads as no actions rather than as blank titles', () => {
    expect(actionTitlesIn(frameOf([], -1))).toEqual([])
  })
})

describe('waiting for a console to let go', () => {
  test(
    'answers false when the promise does not settle inside the deadline',
    async () => {
      // Arrange: the console wedged mid-effect, which `close()` then SIGTERMs.
      const pending = new Promise<number>(() => undefined)

      // Act + Assert
      expect(await settledWithin(pending, DEADLINE_MS)).toBe(false)
    },
    HELPER_TIMEOUT_MS,
  )

  test(
    'answers true for a promise that already resolved',
    async () => {
      expect(await settledWithin(Promise.resolve(0), DEADLINE_MS)).toBe(true)
    },
    HELPER_TIMEOUT_MS,
  )

  test(
    'answers true for a REJECTED promise instead of rejecting the wait',
    async () => {
      // The one that matters: an unhandled rejection here would fail whichever
      // test's `afterEach` happened to close the console.
      const rejected = Promise.reject(new Error('the console blew up'))

      expect(await settledWithin(rejected, DEADLINE_MS)).toBe(true)
    },
    HELPER_TIMEOUT_MS,
  )
})
