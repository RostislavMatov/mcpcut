import { describe, expect, test } from 'vitest'
import { ACTION_COLUMN_WIDTH, COLUMN_GAP, FOOTER_ROWS, HEADER_ROWS } from '../../src/tui/constants.js'
import { NARROW_COLUMNS, STACKED_ACTION_ROWS_SHARE } from '../../src/tui/constants-live.js'
import {
  actionWindowOf,
  bodyLayoutOf,
  bodyLayoutOfRows,
  bodyWidthsOf,
  wrapWords,
} from '../../src/tui/layout.js'
import { pageRowsOf } from '../../src/tui/update-step.js'

/**
 * The body's layout (mcpcut phase 6, F1): two columns on a wide terminal, a
 * band of actions above a full-width pane on a narrow one. Every number here
 * is pinned by a literal rather than recomputed from the constants, because
 * a test that restates the formula would agree with any formula.
 */

/** The size every terminal emulator starts at, and where `pageRowsOf` is pinned. */
const DEFAULT_SIZE = { columns: 80, rows: 24 }
/** Body rows on the default size: 24 minus the header's 3 and the footer's 1. */
const DEFAULT_BODY_ROWS = 20

describe('bodyLayoutOf', () => {
  test('the default 80x24 terminal is two-column with the whole body for both columns', () => {
    const layout = bodyLayoutOf(DEFAULT_SIZE)

    expect(layout).toEqual({
      mode: 'two-column',
      widths: bodyWidthsOf(DEFAULT_SIZE.columns),
      actionRows: DEFAULT_BODY_ROWS,
      paneRows: DEFAULT_BODY_ROWS,
    })
    expect(layout.widths).toEqual({ action: ACTION_COLUMN_WIDTH, gap: COLUMN_GAP, pane: 54 })
  })

  test('the threshold itself (60 columns) is still two-column', () => {
    expect(bodyLayoutOf({ columns: NARROW_COLUMNS, rows: 24 }).mode).toBe('two-column')
    expect(NARROW_COLUMNS).toBe(60)
  })

  test('one column below the threshold stacks', () => {
    expect(bodyLayoutOf({ columns: NARROW_COLUMNS - 1, rows: 24 }).mode).toBe('stacked')
  })

  test('40x12 stacks: a band of a third of the body, one blank row, the pane takes the rest', () => {
    const layout = bodyLayoutOf({ columns: 40, rows: 12 })

    expect(layout).toEqual({
      mode: 'stacked',
      widths: { action: 40, gap: 0, pane: 40 },
      actionRows: 2,
      paneRows: 5,
    })
    expect(STACKED_ACTION_ROWS_SHARE).toBe(3)
  })

  test('20x5 stacks with a one-row band and no pane rows, never a negative count', () => {
    const layout = bodyLayoutOf({ columns: 20, rows: 5 })

    expect(layout.mode).toBe('stacked')
    expect(layout.actionRows).toBe(1)
    expect(layout.paneRows).toBe(0)
  })

  test('a terminal shorter than the header and footer has a body of zero rows in both modes', () => {
    expect(bodyLayoutOf({ columns: 80, rows: HEADER_ROWS + FOOTER_ROWS - 1 }).paneRows).toBe(0)
    expect(bodyLayoutOf({ columns: 30, rows: HEADER_ROWS + FOOTER_ROWS - 1 }).paneRows).toBe(0)
  })
})

describe('bodyLayoutOfRows', () => {
  test('caps the stacked band at the number of actions, so a short list wastes no rows', () => {
    const layout = bodyLayoutOfRows(40, 8, 1)

    expect(layout.actionRows).toBe(1)
    expect(layout.paneRows).toBe(6)
  })

  test('keeps the band at a third when there are more actions than rows for them', () => {
    const layout = bodyLayoutOfRows(40, 9, 12)

    expect(layout.actionRows).toBe(3)
    expect(layout.paneRows).toBe(5)
  })

  test('never gives the band less than one row, even when the body is tiny', () => {
    expect(bodyLayoutOfRows(40, 1, 5).actionRows).toBe(1)
    expect(bodyLayoutOfRows(40, 0, 5).actionRows).toBe(1)
    expect(bodyLayoutOfRows(40, 0, 5).paneRows).toBe(0)
  })

  test('the action count is irrelevant in two-column: both columns own the whole body', () => {
    const layout = bodyLayoutOfRows(80, 20, 1)

    expect(layout.mode).toBe('two-column')
    expect(layout.actionRows).toBe(20)
    expect(layout.paneRows).toBe(20)
  })

  test('bodyLayoutOf equals bodyLayoutOfRows with an unbounded action count', () => {
    expect(bodyLayoutOf({ columns: 40, rows: 12 })).toEqual(
      bodyLayoutOfRows(40, 8, Number.POSITIVE_INFINITY),
    )
  })
})

describe('actionWindowOf', () => {
  test('scrolls the window down only as far as needed to keep the active row visible', () => {
    expect(actionWindowOf(12, 11, 5)).toEqual({ first: 7, last: 11 })
  })

  test('starts at the top while the active row fits, and ends at the last item', () => {
    expect(actionWindowOf(3, 0, 5)).toEqual({ first: 0, last: 2 })
  })

  test('does not scroll while the active row is still inside the first page', () => {
    expect(actionWindowOf(12, 4, 5)).toEqual({ first: 0, last: 4 })
  })

  test('scrolls by exactly one when the active row is one past the bottom', () => {
    expect(actionWindowOf(12, 5, 5)).toEqual({ first: 1, last: 5 })
  })

  test('an empty list yields an empty window (last before first)', () => {
    const window = actionWindowOf(0, 0, 5)

    expect(window.last).toBeLessThan(window.first)
  })

  test('zero rows yields an empty window', () => {
    const window = actionWindowOf(10, 3, 0)

    expect(window.last).toBeLessThan(window.first)
  })
})

describe('pageRowsOf', () => {
  test('is 18 on the default 80x24 terminal, exactly as before the stacked layout existed', () => {
    expect(pageRowsOf(DEFAULT_SIZE)).toBe(18)
  })

  test('is smaller on a narrow terminal, because the band takes rows from the pane', () => {
    expect(pageRowsOf({ columns: 40, rows: 12 })).toBe(3)
  })

  test('never drops below one row, however short the terminal', () => {
    expect(pageRowsOf({ columns: 80, rows: 4 })).toBe(1)
    expect(pageRowsOf({ columns: 20, rows: 5 })).toBe(1)
  })
})

describe('wrapWords', () => {
  test('breaks at spaces so no line exceeds the width', () => {
    expect(wrapWords('one two three four', 9)).toEqual(['one two', 'three', 'four'])
  })

  test('keeps a single word longer than the width on its own line', () => {
    expect(wrapWords('abcdefghij k', 4)).toEqual(['abcdefghij', 'k'])
  })

  test('returns the text whole for a width of zero or less', () => {
    expect(wrapWords('a b', 0)).toEqual(['a b'])
  })
})
