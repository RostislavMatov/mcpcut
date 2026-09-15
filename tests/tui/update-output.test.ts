import { describe, expect, test } from 'vitest'
import {
  ACTION_COLUMN_WIDTH,
  COLUMN_GAP,
  EXIT_OK,
  FOOTER_ROWS,
  HEADER_ROWS,
} from '../../src/tui/constants.js'
import type { Model } from '../../src/tui/model.js'
import {
  OUTPUT_HSCROLL_STEP,
  outputPanelOf,
  type OutputPanel,
  type RunResult,
} from '../../src/tui/output.js'
import { update } from '../../src/tui/update.js'
import {
  ONE_TIME_STDOUT,
  SIZE,
  char,
  key,
  mainModel,
  mainOf,
  mainScreen,
  panelOf,
} from './support/update-fixtures.js'

/**
 * The reducer over the output pane: scrolling it down and sideways, the help
 * pane, and `q` with the question it asks while a one-time token is on screen.
 * Split out of `update.test.ts` (phase 6, task 9); the fixtures are in
 * `support/update-fixtures.ts`.
 */

describe('update: scrolling the output', () => {
  const pageRows = SIZE.rows - HEADER_ROWS - FOOTER_ROWS - 2

  test('PgDn moves one page down', () => {
    const step = update(mainModel({ output: panelOf(100) }), key('pagedown'))

    expect(mainOf(step.model).output?.scroll).toBe(pageRows)
  })

  test('PgUp moves one page up, never past the first line', () => {
    const scrolled = update(mainModel({ output: panelOf(100) }), key('pagedown')).model

    const step = update(update(scrolled, key('pageup')).model, key('pageup'))

    expect(mainOf(step.model).output?.scroll).toBe(0)
  })

  test('End jumps to the last page and Home back to the first', () => {
    const end = update(mainModel({ output: panelOf(100) }), key('end'))

    expect(mainOf(end.model).output?.scroll).toBe(100 - pageRows)
    expect(mainOf(update(end.model, key('home')).model).output?.scroll).toBe(0)
  })

  test('an output shorter than a page does not scroll', () => {
    const step = update(mainModel({ output: panelOf(3) }), key('pagedown'))

    expect(mainOf(step.model).output?.scroll).toBe(0)
  })

  test('a key that is neither a command nor a scroll changes nothing', () => {
    const model = mainModel({ output: panelOf(100) })

    expect(update(model, key('delete')).model).toBe(model)
  })

  test('a scroll key with no output on screen does nothing', () => {
    const model = mainModel()

    expect(update(model, key('pagedown')).model).toBe(model)
  })

  test('a tiny terminal still scrolls by at least one line', () => {
    const model: Model = { screen: mainScreen({ output: panelOf(100) }), size: { columns: 40, rows: 4 } }

    const step = update(model, key('pagedown'))

    expect(mainOf(step.model).output?.scroll).toBe(1)
  })
})

/**
 * Owner tail Q24: the output pane is 54 columns on the 80-column terminal
 * every emulator starts at, and `server list` is wider than that. `[` and `]`
 * are the two keys that move the pane over the part it could not show.
 */
describe('update: scrolling the output sideways', () => {
  const PANE_WIDTH = SIZE.columns - ACTION_COLUMN_WIDTH - COLUMN_GAP
  const LINE_WIDTH = 200

  function widePanel(): OutputPanel {
    return outputPanelOf({
      argv: ['server', 'list'],
      display: ['server', 'list'],
      exitCode: 0,
      stdout: `${'x'.repeat(LINE_WIDTH)}\n`,
      stderr: '',
    })
  }

  test('a fresh panel starts at the left edge', () => {
    expect(widePanel().hScroll).toBe(0)
  })

  test('] moves the view right by one step', () => {
    const step = update(mainModel({ output: widePanel() }), char(']'))

    expect(mainOf(step.model).output?.hScroll).toBe(OUTPUT_HSCROLL_STEP)
  })

  test('[ moves it back, and never past the left edge', () => {
    const right = update(mainModel({ output: widePanel() }), char(']')).model

    const back = update(right, char('['))

    expect(mainOf(back.model).output?.hScroll).toBe(0)
    expect(mainOf(update(back.model, char('[')).model).output?.hScroll).toBe(0)
  })

  test('] stops where the longest line ends, so the pane never scrolls past the text', () => {
    const far = Array.from({ length: 100 }).reduce<Model>(
      (model) => update(model, char(']')).model,
      mainModel({ output: widePanel() }),
    )

    expect(mainOf(far).output?.hScroll).toBe(LINE_WIDTH - PANE_WIDTH)
  })

  test('an output narrower than the pane does not scroll sideways at all', () => {
    const step = update(mainModel({ output: panelOf(3) }), char(']'))

    expect(mainOf(step.model).output?.hScroll).toBe(0)
  })

  test('a sideways key with no output on screen does nothing', () => {
    const model = mainModel()

    expect(update(model, char(']')).model).toBe(model)
  })

  test('a new run starts back at the left edge', () => {
    const scrolled = update(mainModel({ output: widePanel() }), char(']')).model
    const result: RunResult = {
      argv: ['admin', 'list'],
      display: ['admin', 'list'],
      exitCode: 0,
      stdout: 'alice owner\n',
      stderr: '',
    }

    const step = update(scrolled, { kind: 'run-result', result })

    expect(mainOf(step.model).output?.hScroll).toBe(0)
  })
})

describe('update: help, quit and the panes that ask first', () => {
  test('? opens the help pane', () => {
    const step = update(mainModel(), char('?'))

    expect(mainOf(step.model).pane).toEqual({ kind: 'help' })
  })

  test('any key closes the help pane', () => {
    const model = mainModel({ pane: { kind: 'help' } })

    for (const msg of [char('x'), key('enter'), key('escape')]) {
      const step = update(model, msg)

      expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
      expect(step.effects).toEqual([])
    }
  })

  test('q quits when nothing on screen would be lost', () => {
    const step = update(mainModel({ output: panelOf(2) }), char('q'))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
  })

  test('q asks first while a one-time token is on screen', () => {
    // The run that minted it already opened the hold pane (phase 5, plan P2),
    // so `q` is answered from there rather than from the action list.
    const result: RunResult = {
      argv: ['admin', 'add', 'alice'],
      display: ['admin', 'add', 'alice'],
      exitCode: 0,
      stdout: ONE_TIME_STDOUT,
      stderr: '',
      mintsToken: true,
    }
    const held = update(mainModel(), { kind: 'run-result', result }).model
    expect(mainOf(held).pane).toEqual({ kind: 'token-hold' })

    const step = update(held, char('q'))

    expect(mainOf(step.model).pane).toEqual({ kind: 'quit-confirm' })
    expect(step.effects).toEqual([])
  })

  test.each([['y'], ['Y']])('%s at the quit question quits', (answer) => {
    const step = update(mainModel({ pane: { kind: 'quit-confirm' } }), char(answer))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
  })

  test('any other answer at the quit question stays', () => {
    const step = update(mainModel({ pane: { kind: 'quit-confirm' } }), char('n'))

    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
    expect(step.effects).toEqual([])
  })

  test('any other answer returns to the token hold when one is still unsaved', () => {
    const step = update(
      mainModel({
        pane: { kind: 'quit-confirm' },
        output: panelOf(1, { stdout: ONE_TIME_STDOUT, mintsToken: true }),
      }),
      char('n'),
    )

    expect(mainOf(step.model).pane).toEqual({ kind: 'token-hold' })
    expect(step.effects).toEqual([])
  })
})
