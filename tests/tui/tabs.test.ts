import { describe, expect, test } from 'vitest'
import { visibleSections } from '../../src/tui/catalogue/index.js'
import {
  DEFAULT_COLUMNS,
  TAB_OVERFLOW_LEFT,
  TAB_OVERFLOW_RIGHT,
  TAB_SEPARATOR,
} from '../../src/tui/constants.js'
import { tabWindowOf, type TabWindow } from '../../src/tui/tabs.js'

/**
 * The tab bar is a window over the section labels (mcpcut phase 4, Task 9):
 * eleven sections are 115 columns of labels and a terminal is 80, so the bar
 * scrolls sideways the way the action column scrolls down.
 *
 * Two promises are worth a test each. The active tab is ALWAYS inside the
 * window — an operator who pressed a section key and cannot see where they
 * landed has lost the bar — and the window never claims more columns than it
 * was given, unless the active label alone is wider than the terminal, in
 * which case the renderer's `padRight` cuts it and the bar is honest about it.
 *
 * Everything here is pure arithmetic over label widths: no model, no frame.
 */

/** The owner's real labels, the way `render-main` builds them. */
function ownerLabels(): readonly string[] {
  return visibleSections('owner').map((section, index) => `${index + 1} ${section.title}`)
}

/**
 * The width the window claims, restated from the specification rather than
 * borrowed from the implementation: labels, separators between them, and a
 * marker on each side it scrolled past.
 */
function widthOf(labels: readonly string[], window: TabWindow): number {
  const shown = labels.slice(window.first, window.last + 1)
  const separators = Math.max(0, shown.length - 1) * TAB_SEPARATOR.length
  const left = window.hiddenBefore ? TAB_OVERFLOW_LEFT.length : 0
  const right = window.hiddenAfter ? TAB_OVERFLOW_RIGHT.length : 0

  return shown.reduce((total, label) => total + label.length, 0) + separators + left + right
}

/** A deterministic generator, so a failing property has one reproducible case. */
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

const GENERATED_CASES = 20
const MIN_LABELS = 1
const MAX_LABELS = 15
const MIN_LABEL_WIDTH = 3
const MAX_LABEL_WIDTH = 20

interface GeneratedCase {
  readonly labels: readonly string[]
  readonly active: number
  readonly columns: number
}

function generatedCases(): readonly GeneratedCase[] {
  const random = seeded(20260908)
  const between = (low: number, high: number): number =>
    low + Math.floor(random() * (high - low + 1))

  return Array.from({ length: GENERATED_CASES }, () => {
    const count = between(MIN_LABELS, MAX_LABELS)
    const labels = Array.from({ length: count }, (_, index) =>
      `${index + 1} ${'x'.repeat(between(MIN_LABEL_WIDTH, MAX_LABEL_WIDTH))}`,
    )

    return { labels, active: between(0, count - 1), columns: between(1, DEFAULT_COLUMNS) }
  })
}

describe('tabWindowOf: when everything fits', () => {
  test('shows every label and admits nothing is hidden', () => {
    const labels = ['1 Home', '2 Admins']

    const window = tabWindowOf(labels, 0, DEFAULT_COLUMNS)

    expect(window).toEqual({ first: 0, last: 1, hiddenBefore: false, hiddenAfter: false })
  })

  test('a single label fills the whole window', () => {
    expect(tabWindowOf(['1 Home'], 0, DEFAULT_COLUMNS)).toEqual({
      first: 0,
      last: 0,
      hiddenBefore: false,
      hiddenAfter: false,
    })
  })

  test('no labels at all is an empty window, not a crash', () => {
    const window = tabWindowOf([], 0, DEFAULT_COLUMNS)

    expect(window.first).toBe(0)
    expect(window.last).toBeLessThan(window.first)
    expect(window.hiddenBefore).toBe(false)
    expect(window.hiddenAfter).toBe(false)
  })
})

describe('tabWindowOf: when the labels overflow', () => {
  const labels = ownerLabels()

  test('the first tab keeps the left edge and admits what follows', () => {
    const window = tabWindowOf(labels, 0, DEFAULT_COLUMNS)

    expect(window.first).toBe(0)
    expect(window.hiddenBefore).toBe(false)
    expect(window.hiddenAfter).toBe(true)
    expect(window.last).toBeLessThan(labels.length - 1)
  })

  test('the last tab keeps the right edge and admits what precedes it', () => {
    const window = tabWindowOf(labels, labels.length - 1, DEFAULT_COLUMNS)

    expect(window.last).toBe(labels.length - 1)
    expect(window.hiddenAfter).toBe(false)
    expect(window.hiddenBefore).toBe(true)
    expect(window.first).toBeGreaterThan(0)
  })

  test('a tab in the middle admits both sides', () => {
    const middle = Math.floor(labels.length / 2)

    const window = tabWindowOf(labels, middle, 40)

    expect(window.hiddenBefore).toBe(true)
    expect(window.hiddenAfter).toBe(true)
    expect(window.first).toBeLessThanOrEqual(middle)
    expect(window.last).toBeGreaterThanOrEqual(middle)
  })

  test('the twelfth owner section is visible at 80 columns', () => {
    const last = labels.length - 1

    const window = tabWindowOf(labels, last, DEFAULT_COLUMNS)

    expect(labels[last]).toBe('12 Services')
    expect(window.first).toBeLessThanOrEqual(last)
    expect(window.last).toBe(last)
    expect(window.hiddenBefore).toBe(true)
    expect(widthOf(labels, window)).toBeLessThanOrEqual(DEFAULT_COLUMNS)
  })

  test('a label wider than the terminal is still the window, alone', () => {
    const window = tabWindowOf(labels, 7, 10)

    expect(window.first).toBe(7)
    expect(window.last).toBe(7)
  })
})

describe('tabWindowOf: the properties that hold for any labels', () => {
  test('the active tab is inside the window and the window fits, in 20 generated cases', () => {
    for (const { labels, active, columns } of generatedCases()) {
      const window = tabWindowOf(labels, active, columns)

      expect(window.first).toBeLessThanOrEqual(active)
      expect(window.last).toBeGreaterThanOrEqual(active)
      // The one licensed overflow: a single label the terminal cannot hold.
      if (window.first !== window.last) {
        expect(widthOf(labels, window)).toBeLessThanOrEqual(columns)
      }
    }
  })

  test('the markers say exactly which sides were scrolled past', () => {
    for (const { labels, active, columns } of generatedCases()) {
      const window = tabWindowOf(labels, active, columns)

      expect(window.hiddenBefore).toBe(window.first > 0)
      expect(window.hiddenAfter).toBe(window.last < labels.length - 1)
    }
  })
})
