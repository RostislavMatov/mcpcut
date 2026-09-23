import { describe, expect, test } from 'vitest'
import { ansiStyle, padRight, plainStyle } from '../../src/tui/ansi.js'
import { visibleSections } from '../../src/tui/catalogue/index.js'
import {
  ACTION_COLUMN_WIDTH,
  ACTIVE_MARKER,
  COLUMN_GAP,
  FOOTER_ROWS,
  HEADER_ROWS,
  HELP_LINES,
  KEY_HELP_FOOTER,
} from '../../src/tui/constants.js'
import {
  HELP_CLOSE_LINE,
  HELP_WRAP_INDENT,
  TOKEN_HOLD_BANNER,
  TOKEN_HOLD_BANNER_SHORT,
} from '../../src/tui/constants-live.js'
import { formOf } from '../../src/tui/form.js'
import { bodyLayoutOfRows } from '../../src/tui/layout.js'
import {
  type MainScreen,
  mainScreenOf,
  type Model,
  type Pane,
  type RunRequest,
  type Session,
  type TerminalSize,
} from '../../src/tui/model.js'
import { type OutputPanel, outputPanelOf } from '../../src/tui/output.js'
import { renderClientConfig } from '../../src/agents/client-config.js'
import { render } from '../../src/tui/render.js'
import { helpLines } from '../../src/tui/render-help.js'
import { CLIPPED_HELP_FOOTER } from '../../src/tui/render-main.js'
import { bannerFor } from '../../src/tui/render-panes.js'
import { CLI_NAME } from '../../src/setup/constants.js'

/**
 * Phase 6 (F1, F3, F4): what the main screen does when the terminal is
 * narrower than its two columns. Below `NARROW_COLUMNS` the body stacks — a
 * band of actions, a blank row, a full-width pane — and only on the `actions`
 * pane; `?` is an overlay over the whole body in BOTH layouts, wrapping the
 * lines that no longer fit; the token banner shortens when the long one would
 * wrap past two lines. The 80-column two-column frame must not move at all.
 */

const OWNER: Session = { adminName: 'alice', role: 'owner' }

/** The Admins section: five actions, so a band of two rows at 40×12 must scroll. */
const ADMINS = 1

const NARROW: TerminalSize = { columns: 40, rows: 12 }
const WIDE: TerminalSize = { columns: 80, rows: 24 }

const SIZES: readonly TerminalSize[] = [
  WIDE,
  { columns: 40, rows: 10 },
  NARROW,
  { columns: 59, rows: 24 },
  { columns: 200, rows: 50 },
  { columns: 20, rows: 5 },
  { columns: 0, rows: 3 },
]

interface MainPatch {
  readonly sectionIndex?: number
  readonly actionIndex?: number
  readonly pane?: Pane
  readonly output?: OutputPanel
  readonly busy?: RunRequest
}

function mainBase(): MainScreen {
  const screen = mainScreenOf(OWNER, visibleSections(OWNER.role))
  if (screen.kind !== 'main') throw new Error('expected a main screen')
  return screen
}

function mainModel(patch: MainPatch = {}, size: TerminalSize = NARROW): Model {
  return { screen: { ...mainBase(), sectionIndex: ADMINS, ...patch }, size }
}

function panelOf(stdout: string): OutputPanel {
  return outputPanelOf({
    argv: ['admin', 'list'],
    display: ['admin', 'list'],
    exitCode: 0,
    stdout,
    stderr: '',
  })
}

function numberedOutput(count: number): OutputPanel {
  return panelOf(Array.from({ length: count }, (_, index) => `line ${index}`).join('\n'))
}

function tokenPanel(): OutputPanel {
  return panelOf('token: mcpa_abc\nSave this token now: it cannot be recovered or shown again.')
}

function addForm(): Pane {
  const admins = visibleSections(OWNER.role)[ADMINS]
  const add = admins?.actions.find((action) => action.id === 'add')
  if (add === undefined) throw new Error('no admins add action')

  return { kind: 'form', actionId: 'add', form: formOf(add.fields) }
}

const BUSY: RunRequest = { actionId: 'list', argv: ['admin', 'list'], display: ['admin', 'list'] }

/** Every pane kind the main screen can be on, for the frame-shape loop. */
const PANES: readonly { readonly name: string; readonly patch: MainPatch }[] = [
  { name: 'actions', patch: {} },
  { name: 'actions with output', patch: { output: numberedOutput(40) } },
  { name: 'actions while busy', patch: { output: numberedOutput(40), busy: BUSY } },
  { name: 'form', patch: { pane: addForm(), actionIndex: 1 } },
  {
    name: 'confirm',
    patch: {
      pane: { kind: 'confirm', actionId: 'remove', request: BUSY, question: 'Remove admin "bob"?' },
    },
  },
  { name: 'help', patch: { pane: { kind: 'help' } } },
  { name: 'quit-confirm', patch: { pane: { kind: 'quit-confirm' }, output: tokenPanel() } },
  { name: 'token-hold', patch: { pane: { kind: 'token-hold' }, output: tokenPanel() } },
]

function bodyOf(lines: readonly string[]): readonly string[] {
  return lines.slice(HEADER_ROWS, -FOOTER_ROWS)
}

function stripSgr(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, '')
}

function bandRowsAt(size: TerminalSize, actionCount: number): number {
  return bodyLayoutOfRows(size.columns, size.rows - HEADER_ROWS - FOOTER_ROWS, actionCount).actionRows
}

describe('render-narrow: the stacked body (F1)', () => {
  const ADMINS_ACTIONS = visibleSections(OWNER.role)[ADMINS]?.actions.length ?? 0

  test('the first body row is the active action, the full width of the terminal', () => {
    const lines = render(mainModel(), plainStyle)

    expect(lines[HEADER_ROWS]).toBe(padRight(`${ACTIVE_MARKER}list`, NARROW.columns))
  })

  test('the band is as tall as the layout says, then one blank row, then the pane', () => {
    const band = bandRowsAt(NARROW, ADMINS_ACTIONS)
    const body = bodyOf(render(mainModel({ output: numberedOutput(40) }), plainStyle))

    expect(band).toBe(2)
    expect(body.slice(0, band).every((row) => row.startsWith(ACTIVE_MARKER) || row.startsWith('  '))).toBe(true)
    expect(body[band]).toBe(' '.repeat(NARROW.columns))
    expect(body[band + 1]).toBe(padRight(`$ ${CLI_NAME} admin list`, NARROW.columns))
  })

  test('the command line of the pane starts at column 0 and uses the full width', () => {
    const wide = 'w'.repeat(38)
    const body = bodyOf(render(mainModel({ output: panelOf(`${wide}\n`) }), plainStyle))
    const band = bandRowsAt(NARROW, ADMINS_ACTIONS)

    expect(body[band + 2]).toBe(padRight(wide, NARROW.columns))
    expect(body[band + 2]?.startsWith('w')).toBe(true)
  })

  test('the band scrolls so the selected action is on screen', () => {
    const lines = render(mainModel({ actionIndex: 4 }, { columns: 40, rows: 10 }), plainStyle)

    expect(lines.some((line) => line.startsWith(`${ACTIVE_MARKER}remove`))).toBe(true)
  })

  test('a form takes the whole body: no band above it', () => {
    const lines = render(mainModel({ pane: addForm(), actionIndex: 1 }), plainStyle)

    expect(lines[HEADER_ROWS]).toBe(padRight('add', NARROW.columns))
    expect(bodyOf(lines).some((row) => row.startsWith(`${ACTIVE_MARKER}add`))).toBe(false)
  })

  test('the run in flight is announced inside the pane, under the band', () => {
    const band = bandRowsAt(NARROW, ADMINS_ACTIONS)
    const body = bodyOf(render(mainModel({ busy: BUSY }), plainStyle))

    expect(body[band + 1]).toBe(padRight(`running: $ ${CLI_NAME} admin list`, NARROW.columns))
  })

  test('the pane is measured at the full width, so a line that fits it is not called clipped', () => {
    const fits = render(mainModel({ output: panelOf(`${'w'.repeat(30)}\n`) }), plainStyle)
    const cut = render(mainModel({ output: panelOf(`${'w'.repeat(90)}\n`) }), plainStyle)

    expect(fits.at(-1)).toBe(padRight(KEY_HELP_FOOTER, NARROW.columns))
    expect(cut.at(-1)).toBe(padRight(CLIPPED_HELP_FOOTER, NARROW.columns))
  })

  test('at 59 columns the body stacks, at 60 it does not', () => {
    const stacked = render(mainModel({}, { columns: 59, rows: 24 }), plainStyle)
    const twoColumn = render(mainModel({}, { columns: 60, rows: 24 }), plainStyle)

    expect(stacked[HEADER_ROWS]).toBe(padRight(`${ACTIVE_MARKER}list`, 59))
    expect(twoColumn[HEADER_ROWS]?.slice(ACTION_COLUMN_WIDTH + COLUMN_GAP).trim()).not.toBe('')
  })
})

describe('render-narrow: the two-column frame at 80×24 is composed as before', () => {
  const PANE_WIDTH = WIDE.columns - ACTION_COLUMN_WIDTH - COLUMN_GAP

  test('a body row is the action cell, the gap and the pane cell, joined', () => {
    const lines = render(mainModel({ output: numberedOutput(40) }, WIDE), plainStyle)

    expect(lines[HEADER_ROWS]).toBe(
      `${padRight(`${ACTIVE_MARKER}list`, ACTION_COLUMN_WIDTH)}${' '.repeat(COLUMN_GAP)}${padRight(`$ ${CLI_NAME} admin list`, PANE_WIDTH)}`,
    )
  })

  test('a section whose actions fit the body lists them all from the first row', () => {
    const lines = render(mainModel({}, WIDE), plainStyle)
    const titles = bodyOf(lines)
      .map((row) => row.slice(ACTIVE_MARKER.length, ACTION_COLUMN_WIDTH).trimEnd())
      .filter((title) => title !== '')

    expect(titles).toEqual(['list', 'add', 'rotate', 'role', 'remove'])
  })
})

describe('render-narrow: the ? overlay (F3)', () => {
  test('at 80 columns the first body row is the first help line, whole and full width', () => {
    const lines = render(mainModel({ pane: { kind: 'help' } }, WIDE), plainStyle)

    expect(lines[HEADER_ROWS]).toBe(padRight(HELP_LINES[0] ?? '', WIDE.columns))
    expect(bodyOf(lines).some((row) => row.includes('…'))).toBe(false)
  })

  test('at 40 columns a wide line splits: keys on one row, the description indented under it', () => {
    const lines = render(mainModel({ pane: { kind: 'help' } }), plainStyle)

    expect(lines[HEADER_ROWS]).toBe(padRight('Tab / S-Tab / 1-9 / h l', NARROW.columns))
    expect(lines[HEADER_ROWS + 1]).toBe(
      padRight(`${' '.repeat(HELP_WRAP_INDENT)}move between sections`, NARROW.columns),
    )
  })

  test('helpLines keeps a line that fits, wraps one that does not, and closes with the hint', () => {
    const lines = helpLines(40, 100)

    expect(lines).toContain(padRight('?                       show this help', 40))
    expect(lines.at(-1)).toBe(padRight(HELP_CLOSE_LINE, 40))
    expect(lines.at(-2)).toBe(' '.repeat(40))
    expect(lines.every((line) => line.length === 40 && !line.includes('…'))).toBe(true)
  })

  test('helpLines yields at most `rows` lines, the first ones, and none for no rows', () => {
    expect(helpLines(80, 3)).toEqual(HELP_LINES.slice(0, 3).map((line) => padRight(line, 80)))
    expect(helpLines(80, 0)).toEqual([])
  })

  test('the overlay ends with the closing hint when the body has the rows for it', () => {
    const lines = render(mainModel({ pane: { kind: 'help' } }, WIDE), plainStyle)

    expect(bodyOf(lines)).toContain(padRight(HELP_CLOSE_LINE, WIDE.columns))
  })
})

describe('render-narrow: the token banner (F4)', () => {
  test('bannerFor keeps the long banner while it wraps to two lines and shortens beyond', () => {
    expect(bannerFor(54)).toBe(TOKEN_HOLD_BANNER)
    expect(bannerFor(40)).toBe(TOKEN_HOLD_BANNER)
    expect(bannerFor(30)).toBe(TOKEN_HOLD_BANNER_SHORT)
  })

  test('a held token at 40×12 shows the banner and keeps the token line on screen', () => {
    const lines = render(mainModel({ pane: { kind: 'token-hold' }, output: tokenPanel() }), plainStyle)
    const text = lines.join('\n')

    expect(lines[HEADER_ROWS]?.startsWith('One-time token on screen:')).toBe(true)
    expect(text).toContain('token: mcpa_abc')
  })

  test('an agent token with its client config at 40×24: banner and token first, JSON clipped with ›, nothing wrapped', () => {
    // `agent create` prints the block under the notice (ADR-0015, phase 4).
    // The pane never wraps: a line wider than the body is clipped and marked,
    // and `[`/`]` slide it — the one layout the block's lines have to survive.
    const stdout =
      'agent: research-bot\ntoken: mcpj_abc\nSave this token now: it cannot be recovered or shown again.\n\n' +
      renderClientConfig({ serveUrl: 'https://plane.example.com:8090', token: 'mcpj_abc', form: 'stdio' })
    const output = outputPanelOf({
      argv: ['agent', 'create', 'research-bot'],
      display: ['agent', 'create', 'research-bot'],
      exitCode: 0,
      stdout,
      stderr: '',
      mintsToken: true,
    })

    // 12 rows show the banner and the token only — the block is a PgDn away
    // there (the pane's rows do not subtract the banner, Q29/Q30); 24 show both.
    const size: TerminalSize = { columns: 40, rows: 24 }

    const lines = render(mainModel({ pane: { kind: 'token-hold' }, output }, size), plainStyle)
    const text = lines.join('\n')

    expect(lines[HEADER_ROWS]?.startsWith('One-time token on screen:')).toBe(true)
    expect(text).toContain('token: mcpj_abc')
    expect(text).toContain('"mcpServers"')
    expect(text).toContain('›')
    expect(lines.every((line) => line.length <= size.columns)).toBe(true)
    expect(lines).toHaveLength(size.rows)
  })

  test('a held token at 30 columns shows the short banner', () => {
    const size: TerminalSize = { columns: 30, rows: 12 }
    const lines = render(mainModel({ pane: { kind: 'token-hold' }, output: tokenPanel() }, size), plainStyle)
    const text = lines.join('\n')

    expect(text).toContain('press y.')
    expect(text).not.toContain('leaves with')
    expect(text).toContain('token: mcpa_abc')
  })
})

describe('render-narrow: the shape of a frame on every pane', () => {
  for (const size of SIZES) {
    for (const pane of PANES) {
      test(`${pane.name} at ${size.columns}×${size.rows} is exactly ${size.rows} lines of ${size.columns} columns`, () => {
        const lines = render(mainModel(pane.patch, size), plainStyle)

        expect(lines).toHaveLength(size.rows)
        expect(lines.every((line) => line.length === size.columns)).toBe(true)
      })
    }
  }
})

describe('render-narrow: styles are decoration only at 40×12', () => {
  for (const pane of PANES) {
    test(`the styled ${pane.name} frame strips back to the plain one`, () => {
      const model = mainModel(pane.patch)

      expect(render(model, ansiStyle).map(stripSgr)).toEqual(render(model, plainStyle))
    })
  }
})
