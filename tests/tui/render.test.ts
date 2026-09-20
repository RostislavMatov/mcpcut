import { describe, expect, test } from 'vitest'
import { ansiStyle, padRight, plainStyle } from '../../src/tui/ansi.js'
import { visibleSections } from '../../src/tui/catalogue/index.js'
import {
  ACTION_COLUMN_WIDTH,
  ACTIVE_MARKER,
  COLUMN_GAP,
  CONSOLE_TITLE,
  exitLine,
  FOOTER_ROWS,
  FORM_HELP_FOOTER,
  HEADER_ROWS,
  HELP_LINES,
  KEY_HELP_FOOTER,
  QUIT_WITH_TOKEN_QUESTION,
  SECRET_MASK_CHAR,
  SIGNIN_TITLE,
  SIGNIN_TOKEN_LABEL,
  SIGNIN_UNKNOWN_TOKEN_NOTICE,
} from '../../src/tui/constants.js'
import { editFocused, formOf, validateForm, type Form } from '../../src/tui/form.js'
import {
  initialModel,
  type MainScreen,
  mainScreenOf,
  type Model,
  type Pane,
  type RunRequest,
  type Session,
  type TerminalSize,
} from '../../src/tui/model.js'
import {
  OUTPUT_CLIP_LEFT_MARKER,
  OUTPUT_CLIP_MARKER,
  OUTPUT_HSCROLL_STEP,
  outputPanelOf,
  type OutputPanel,
} from '../../src/tui/output.js'
import { render } from '../../src/tui/render.js'
import { CLIPPED_HELP_FOOTER, RUNNING_HELP_FOOTER } from '../../src/tui/render-main.js'
import { SIGNIN_BUSY_TEXT, SIGNIN_FOOTER } from '../../src/tui/render-signin.js'
import { servicesHeaderPart, type ServiceSummary } from '../../src/tui/services-summary.js'
import { TAB_ACTIVE_MARK, TAB_OVERFLOW_LEFT, TAB_OVERFLOW_RIGHT } from '../../src/tui/tabs-constants.js'
import { wizardScreenOf } from '../../src/tui/wizard-fields.js'
import { CLI_NAME } from '../../src/setup/constants.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'

/**
 * The renderer is the console's only writer of frames, so its contract is a
 * shape contract before it is a content one: exactly `rows` lines, none wider
 * than `columns`, at every terminal size the console may be handed. On top of
 * that sits the one security invariant of the screen — a secret field is
 * drawn as a mask and never as what was typed.
 *
 * Everything here is pure: a model in, lines out, no terminal.
 */

const OWNER: Session = { adminName: 'alice', role: 'owner' }

const SIZES: readonly TerminalSize[] = [
  { columns: 80, rows: 24 },
  { columns: 40, rows: 10 },
  { columns: 200, rows: 50 },
  { columns: 20, rows: 5 },
]

const DEFAULT_SIZE: TerminalSize = { columns: 80, rows: 24 }

/** Only the fields a test overrides; written out so optional props stay optional. */
interface MainPatch {
  readonly sectionIndex?: number
  readonly actionIndex?: number
  readonly pane?: Pane
  readonly output?: OutputPanel
  readonly services?: readonly ServiceSummary[]
  readonly busy?: RunRequest
}

function mainBase(): MainScreen {
  const screen = mainScreenOf(OWNER, visibleSections(OWNER.role))
  if (screen.kind !== 'main') throw new Error('expected a main screen')
  return screen
}

function mainModel(patch: MainPatch = {}, size: TerminalSize = DEFAULT_SIZE, install?: Model['install']): Model {
  return { screen: { ...mainBase(), ...patch }, size, ...(install === undefined ? {} : { install }) }
}

function typed(form: Form, text: string): Form {
  return [...text].reduce((current, char) => editFocused(current, { kind: 'char', char }), form)
}

function wizardModel(size: TerminalSize = DEFAULT_SIZE): Model {
  const screen = wizardScreenOf({
    mode: 'first-run',
    configPath: '/home/op/.mcpcut/config.json',
    config: defaultInstallConfig('/var/lib/x'),
  })

  return { screen, size }
}

function signinModel(text: string, size: TerminalSize = DEFAULT_SIZE): Model {
  const model = initialModel(size)
  if (model.screen.kind !== 'signin') throw new Error('expected a sign-in screen')

  return { ...model, screen: { ...model.screen, form: typed(model.screen.form, text) } }
}

function panelOf(stdout: string, exitCode = 0): OutputPanel {
  return outputPanelOf({
    argv: ['admin', 'list'],
    display: ['admin', 'list'],
    exitCode,
    stdout,
    stderr: '',
  })
}

function numberedOutput(count: number): OutputPanel {
  return panelOf(Array.from({ length: count }, (_, index) => `line ${index}`).join('\n'))
}

function adminAction(id: string) {
  const admins = visibleSections(OWNER.role).find((section) => section.id === 'admins')
  const action = admins?.actions.find((each) => each.id === id)
  if (action === undefined) throw new Error(`no admins action ${id}`)

  return action
}

function stripSgr(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, '')
}

function joined(lines: readonly string[]): string {
  return lines.join('\n')
}

describe('render: the shape of a frame', () => {
  for (const size of SIZES) {
    test(`the sign-in screen is exactly ${size.rows} lines of exactly ${size.columns} columns`, () => {
      const lines = render(signinModel('mcpa_secret', size), plainStyle)

      expect(lines).toHaveLength(size.rows)
      expect(lines.every((line) => line.length === size.columns)).toBe(true)
    })

    test(`the main screen is exactly ${size.rows} lines of exactly ${size.columns} columns`, () => {
      const model = mainModel({ output: numberedOutput(40), sectionIndex: 1 }, size)

      const lines = render(model, plainStyle)

      expect(lines).toHaveLength(size.rows)
      expect(lines.every((line) => line.length === size.columns)).toBe(true)
    })

    test(`the wizard is exactly ${size.rows} lines of exactly ${size.columns} columns`, () => {
      const lines = render(wizardModel(size), plainStyle)

      expect(lines).toHaveLength(size.rows)
      expect(lines.every((line) => line.length === size.columns)).toBe(true)
    })
  }

  test('a terminal of no rows yields no lines at all', () => {
    expect(render(mainModel({}, { columns: 80, rows: 0 }), plainStyle)).toEqual([])
    expect(render(signinModel('', { columns: 80, rows: 0 }), plainStyle)).toEqual([])
  })

  test('a terminal with no room at all still yields the rows it asked for', () => {
    const lines = render(mainModel({}, { columns: 0, rows: 3 }), plainStyle)

    expect(lines).toHaveLength(3)
    expect(lines.every((line) => line === '')).toBe(true)
  })
})

describe('render: the sign-in screen', () => {
  test('masks the token instead of drawing it', () => {
    const lines = render(signinModel('mcpa_secret'), plainStyle)

    expect(joined(lines)).not.toContain('mcpa_secret')
    expect(joined(lines)).toContain(SECRET_MASK_CHAR.repeat('mcpa_secret'.length))
  })

  test('shows the title, the field label and the footer', () => {
    const lines = render(signinModel(''), plainStyle)
    const text = joined(lines)

    expect(text).toContain(CONSOLE_TITLE)
    expect(text).toContain(SIGNIN_TITLE)
    expect(text).toContain(`${SIGNIN_TOKEN_LABEL}:`)
    expect(lines.at(-1)).toContain(SIGNIN_FOOTER)
  })

  test('replaces the field with a progress word while the token is being resolved', () => {
    const model = signinModel('mcpa_secret')
    if (model.screen.kind !== 'signin') throw new Error('expected a sign-in screen')

    const lines = render({ ...model, screen: { ...model.screen, busy: true } }, plainStyle)

    expect(joined(lines)).toContain(SIGNIN_BUSY_TEXT)
    expect(joined(lines)).not.toContain(SECRET_MASK_CHAR.repeat('mcpa_secret'.length))
  })

  test('shows the notice of a refused token', () => {
    const model = signinModel('')
    if (model.screen.kind !== 'signin') throw new Error('expected a sign-in screen')

    const lines = render(
      { ...model, screen: { ...model.screen, notice: SIGNIN_UNKNOWN_TOKEN_NOTICE } },
      plainStyle,
    )

    expect(joined(lines)).toContain(SIGNIN_UNKNOWN_TOKEN_NOTICE)
  })
})

describe('render: the header of the main screen', () => {
  test('names the admin, the role and the services', () => {
    const services: readonly ServiceSummary[] = [
      { service: 'ui', state: 'running', host: '127.0.0.1', port: 8091 },
    ]

    const lines = render(mainModel({ services }), plainStyle)

    expect(lines[0]).toContain(CONSOLE_TITLE)
    expect(lines[0]).toContain('alice (owner)')
    expect(lines[0]).toContain(servicesHeaderPart(services))
  })

  test('numbers the tabs and rules them off', () => {
    const lines = render(mainModel(), plainStyle)

    expect(lines[1]).toContain('1 Home')
    expect(lines[1]).toContain('2 Admins')
    expect(lines[2]).toBe('─'.repeat(DEFAULT_SIZE.columns))
  })

  test('a remote console (2026-09-20) names host:port, never the scheme', () => {
    const install: Model['install'] = { supervisor: 'mcpcut', remote: true, remoteAddress: 'https://plane.example.com:8091' }

    const lines = render(mainModel({}, DEFAULT_SIZE, install), plainStyle)

    expect(lines[0]).toContain('alice (owner) @ plane.example.com:8091')
    expect(lines[0]).not.toContain('https://')
  })

  test('a default-port address shows no port at all', () => {
    const install: Model['install'] = { supervisor: 'mcpcut', remote: true, remoteAddress: 'https://plane.example.com' }

    const lines = render(mainModel({}, DEFAULT_SIZE, install), plainStyle)

    expect(lines[0]).toContain('alice (owner) @ plane.example.com')
    expect(lines[0]).not.toContain('plane.example.com:')
  })

  test('a local console (install absent, or remote absent) is byte-for-byte the local header', () => {
    const withoutInstall = render(mainModel(), plainStyle)[0]
    const withLocalInstall = render(mainModel({}, DEFAULT_SIZE, { supervisor: 'mcpcut' }), plainStyle)[0]

    expect(withoutInstall).not.toContain('@')
    expect(withLocalInstall).toBe(withoutInstall)
  })

  test('a narrow terminal still fills its width exactly with the address on it', () => {
    const install: Model['install'] = { supervisor: 'mcpcut', remote: true, remoteAddress: 'https://plane.example.com:8091' }
    const size: TerminalSize = { columns: 40, rows: 10 }

    const lines = render(mainModel({}, size, install), plainStyle)

    expect(lines.every((line) => line.length === size.columns)).toBe(true)
  })

  test('inverses the active tab only, and leaves its mark outside the inversion', () => {
    const lines = render(mainModel({ sectionIndex: 1 }), ansiStyle)

    expect(lines[1]).toContain(`${TAB_ACTIVE_MARK}\x1b[7m2 Admins\x1b[27m`)
    expect(lines[1]).not.toContain(`\x1b[7m1 Home\x1b[27m`)
  })

  test('marks the active tab with a glyph in plain style (Q33)', () => {
    const lines = render(mainModel({ sectionIndex: 1 }), plainStyle)

    expect(lines[1]).toContain(`${TAB_ACTIVE_MARK}2 Admins`)
    expect(lines[1]).toBe(
      '‹ ▸2 Admins  3 Servers  4 Vault  5 Agents  6 Groups  7 Policy  8 Quarantine ›'
        .padEnd(DEFAULT_SIZE.columns),
    )
    expect(lines[1]?.split(TAB_ACTIVE_MARK).length).toBe(2)
  })

  test('without colour the active tab is still told apart from its neighbour (Q33)', () => {
    // Wide enough that every tab fits: the window cannot scroll and differ on its own.
    const wide: TerminalSize = { columns: 200, rows: 50 }
    const admins = render(mainModel({ sectionIndex: 1 }, wide), plainStyle)
    const servers = render(mainModel({ sectionIndex: 2 }, wide), plainStyle)

    expect(admins[1]).not.toBe(servers[1])
  })

  test('scrolls the tab bar to the last section and marks what it scrolled past', () => {
    const services = visibleSections(OWNER.role).length - 1

    const lines = render(mainModel({ sectionIndex: services }), plainStyle)

    expect(lines[1]).toContain('12 Services')
    expect(lines[1]).toContain(TAB_OVERFLOW_LEFT)
    expect(lines[1]).not.toContain(TAB_OVERFLOW_RIGHT)
  })

  test('keeps the left edge on the first section and marks what follows it', () => {
    const lines = render(mainModel({ sectionIndex: 0 }), plainStyle)

    expect(lines[1]).toContain('1 Home')
    expect(lines[1]).toContain(TAB_OVERFLOW_RIGHT)
    expect(lines[1]).not.toContain(TAB_OVERFLOW_LEFT)
  })

  test('the tab bar is exactly as wide as the terminal, and never truncated', () => {
    for (const sectionIndex of [0, 5, visibleSections(OWNER.role).length - 1]) {
      const lines = render(mainModel({ sectionIndex }), plainStyle)

      expect(lines[1]?.length).toBe(DEFAULT_SIZE.columns)
      expect(lines[1]).not.toContain('…')
      expect(lines[1]).toContain(`${TAB_ACTIVE_MARK}${sectionIndex + 1} `)
    }
  })

  test('the marked ansi tab bar is as wide as the terminal once SGR is stripped', () => {
    for (const sectionIndex of [0, 5, visibleSections(OWNER.role).length - 1]) {
      const lines = render(mainModel({ sectionIndex }), ansiStyle)

      expect(lines[1]?.replace(/\x1b\[[0-9;]*m/g, '').length).toBe(DEFAULT_SIZE.columns)
    }
  })

  test('a terminal narrower than one label shows that label and nothing else', () => {
    const narrow: TerminalSize = { columns: 20, rows: 24 }

    const lines = render(mainModel({ sectionIndex: 7 }, narrow), plainStyle)

    expect(lines[1]?.length).toBe(narrow.columns)
    expect(lines[1]).toContain(TAB_OVERFLOW_LEFT)
    expect(lines[1]).not.toContain('7 Policy')
  })

  test('a 40-column terminal draws a tab bar without throwing', () => {
    const size: TerminalSize = { columns: 40, rows: 12 }

    const lines = render(mainModel({ sectionIndex: 7 }, size), plainStyle)

    expect(lines[1]?.length).toBe(size.columns)
    expect(lines[1]).toContain('8 Quarantine')
  })
})

describe('render: the action column', () => {
  test('marks the selected action and lists the others', () => {
    const lines = render(mainModel({ sectionIndex: 1, actionIndex: 1 }), plainStyle)
    const body = lines.slice(HEADER_ROWS)

    expect(body[0]?.startsWith('  list')).toBe(true)
    expect(body[1]?.startsWith(`${ACTIVE_MARKER}add`)).toBe(true)
    expect(joined(body)).toContain('remove')
  })

  test('carries the key footer on the last row, cut to the terminal', () => {
    const narrow = render(mainModel(), plainStyle)
    const wide = render(mainModel({}, { columns: 200, rows: 50 }), plainStyle)

    expect(narrow.at(-1)).toBe(padRight(KEY_HELP_FOOTER, DEFAULT_SIZE.columns))
    expect(wide.at(-1)?.trimEnd()).toBe(KEY_HELP_FOOTER)
  })
})

describe('render: the output pane', () => {
  test('opens with the command line and ends on the exit line', () => {
    const lines = render(mainModel({ output: panelOf('alice owner\n') }), plainStyle)

    expect(lines[HEADER_ROWS]).toContain(`$ ${CLI_NAME} admin list`)
    expect(lines[HEADER_ROWS + 1]).toContain('alice owner')
    expect(lines[DEFAULT_SIZE.rows - FOOTER_ROWS - 1]).toContain(exitLine(0))
  })

  test('keeps the exit line visible when the output is scrolled', () => {
    const output = { ...numberedOutput(40), scroll: 5 }

    const lines = render(mainModel({ output }), plainStyle)

    expect(lines[HEADER_ROWS + 1]).toContain('line 5')
    expect(joined(lines)).not.toContain('line 4 ')
    expect(lines[DEFAULT_SIZE.rows - FOOTER_ROWS - 1]).toContain(exitLine(0))
  })

  test('shows a section intro until something has been run', () => {
    const lines = render(mainModel({ sectionIndex: 1 }), plainStyle)

    expect(joined(lines)).toContain('Named admins of this installation')
  })

  test('announces the run in flight above the pane', () => {
    const busy: RunRequest = { actionId: 'list', argv: ['admin', 'list'], display: ['admin', 'list'] }

    const lines = render(mainModel({ busy, sectionIndex: 1 }), plainStyle)

    expect(lines[HEADER_ROWS]).toContain(`running: $ ${CLI_NAME} admin list`)
  })
})

describe('render: the form pane', () => {
  test('draws every field kind and the hint of a valid one', () => {
    const action = adminAction('add')
    const form = validateForm(typed(formOf(action.fields), 'bob'))

    const lines = render(
      mainModel({ sectionIndex: 1, actionIndex: 1, pane: { kind: 'form', actionId: 'add', form } }),
      plainStyle,
    )
    const text = joined(lines)

    expect(text).toContain('[bob')
    expect(text).toContain('‹ owner ›')
    expect(text).toContain('[a-z0-9]')
    expect(lines.at(-1)).toBe(padRight(FORM_HELP_FOOTER, DEFAULT_SIZE.columns))
  })

  test('replaces the hint of a bad field with its error', () => {
    const action = adminAction('add')
    const form = validateForm(typed(formOf(action.fields), 'Bad Name'))

    const lines = render(
      mainModel({ sectionIndex: 1, actionIndex: 1, pane: { kind: 'form', actionId: 'add', form } }),
      plainStyle,
    )

    expect(joined(lines)).toContain('must match')
  })

  test('masks a secret field of a form pane too', () => {
    const form = formOf([{ name: 'token', label: 'Token', kind: 'secret', required: true }])

    const lines = render(
      mainModel({ pane: { kind: 'form', actionId: 'status', form: typed(form, 'shh') } }),
      plainStyle,
    )

    expect(joined(lines)).not.toContain('shh')
    expect(joined(lines)).toContain(SECRET_MASK_CHAR.repeat(3))
  })

  test('sizes the label column to the longest label, so the widgets line up', () => {
    const form = formOf([
      { name: 'entry-point', label: 'Entry point', kind: 'text' },
      { name: 'server', label: 'Server', kind: 'text' },
    ])

    const lines = render(
      mainModel({ pane: { kind: 'form', actionId: 'status', form } }),
      plainStyle,
    )
    const widgetRows = lines.filter((line) => line.includes('['))

    expect(widgetRows).toHaveLength(2)
    expect(widgetRows[0]?.indexOf('[')).toBe(widgetRows[1]?.indexOf('['))
    expect(widgetRows[0]?.indexOf('[')).toBeGreaterThan('Entry point'.length)
  })

  test('draws a flag field as a box, ticked or not', () => {
    const off = formOf([{ name: 'json', label: 'Json', kind: 'flag' }])
    const on = formOf([{ name: 'json', label: 'Json', kind: 'flag', initial: 'true' }])
    const paneOf = (form: Form): Pane => ({ kind: 'form', actionId: 'status', form })

    expect(joined(render(mainModel({ pane: paneOf(off) }), plainStyle))).toContain('[ ]')
    expect(joined(render(mainModel({ pane: paneOf(on) }), plainStyle))).toContain('[x]')
  })
})

describe('render: the confirming and helping panes', () => {
  test('asks the question of a confirm pane', () => {
    const request: RunRequest = {
      actionId: 'remove',
      argv: ['admin', 'remove', 'bob'],
      display: ['admin', 'remove', 'bob'],
    }
    const pane: Pane = { kind: 'confirm', actionId: 'remove', request, question: 'Remove admin?' }

    const lines = render(mainModel({ pane, sectionIndex: 1 }), plainStyle)

    expect(joined(lines)).toContain('Remove admin?')
    expect(joined(lines)).toContain('y/N')
  })

  test('lists the key bindings of the help pane', () => {
    const lines = render(mainModel({ pane: { kind: 'help' } }), plainStyle)

    expect(joined(lines)).toContain(HELP_LINES[0])
  })

  test('asks before a quit that would take a one-time token with it', () => {
    const lines = render(mainModel({ pane: { kind: 'quit-confirm' } }), plainStyle)

    expect(joined(lines)).toContain(QUIT_WITH_TOKEN_QUESTION.slice(0, 40))
  })

  test('wraps the quit question, so its answer is visible in an 80-column pane', () => {
    const lines = render(mainModel({ pane: { kind: 'quit-confirm' } }), plainStyle)

    expect(lines.some((line) => line.includes('Quit anyway? [y/N]'))).toBe(true)
    expect(lines.every((line) => line.length <= 80)).toBe(true)
  })

  test('wraps a confirm question wider than the pane at word boundaries', () => {
    const question =
      'Rotate the token of "alice"? The old token stops working and its browser sessions end.'
    const request: RunRequest = {
      actionId: 'rotate',
      argv: ['admin', 'rotate', 'alice'],
      display: ['admin', 'rotate', 'alice'],
    }
    const pane: Pane = { kind: 'confirm', actionId: 'rotate', request, question }

    const lines = render(mainModel({ pane, sectionIndex: 1 }), plainStyle)

    expect(lines.some((line) => line.includes('browser sessions end.'))).toBe(true)
    expect(lines.some((line) => line.includes('…'))).toBe(false)
    expect(joined(lines)).toContain('y/N')
  })
})

/** Where the right-hand pane starts, and how wide it is on the default terminal. */
const PANE_START = ACTION_COLUMN_WIDTH + COLUMN_GAP
const PANE_WIDTH = DEFAULT_SIZE.columns - PANE_START

/** The pane half of one rendered row, with its trailing padding removed. */
function paneOf(line: string | undefined): string {
  return (line ?? '').slice(PANE_START).trimEnd()
}

/**
 * Owner tail Q19: `ActionSpec.hint` was data no renderer drew. It now appears
 * in the two places an operator meets an action — the form it opens, and the
 * pane beside the cursor resting on it.
 */
describe('render: the hint of an action', () => {
  const ADD_HINT = 'prints the admin’s token once — copy it before leaving'

  function addFormModel(size: TerminalSize = DEFAULT_SIZE): Model {
    const form = formOf(adminAction('add').fields)
    return mainModel(
      { sectionIndex: 1, actionIndex: 1, pane: { kind: 'form', actionId: 'add', form } },
      size,
    )
  }

  test('the form draws the hint under its title, and the first field one row lower', () => {
    const lines = render(addFormModel(), plainStyle)

    expect(paneOf(lines[HEADER_ROWS])).toBe('add')
    expect(paneOf(lines[HEADER_ROWS + 1])).toBe(ADD_HINT)
    expect(lines[HEADER_ROWS + 2]).toContain('Name')
  })

  test('the hint is dimmed, and the padding around it is not counted as width', () => {
    const styled = render(addFormModel(), ansiStyle)

    expect(styled[HEADER_ROWS + 1]).toContain('\x1b[2m')
    expect(styled.map(stripSgr)).toEqual(render(addFormModel(), plainStyle))
  })

  test('an action with no hint puts its first field straight under the title', () => {
    const form = formOf(adminAction('rotate').fields)
    const model = mainModel({
      sectionIndex: 1,
      actionIndex: 2,
      pane: { kind: 'form', actionId: 'rotate', form },
    })

    const lines = render(model, plainStyle)

    expect(paneOf(lines[HEADER_ROWS])).toBe('rotate')
    expect(lines[HEADER_ROWS + 1]).toContain('Name')
  })

  test('the actions pane ends the section intro with a blank row and the hint', () => {
    const lines = render(mainModel({ sectionIndex: 1, actionIndex: 1 }), plainStyle)

    expect(paneOf(lines[HEADER_ROWS + 2])).toContain('recorded under their name.')
    expect(paneOf(lines[HEADER_ROWS + 3])).toBe('')
    expect(paneOf(lines[HEADER_ROWS + 4])).toBe(ADD_HINT)
  })

  test('the hint follows the cursor, and an action without one shows none', () => {
    const onList = render(mainModel({ sectionIndex: 1, actionIndex: 0 }), plainStyle)
    const onAdd = render(mainModel({ sectionIndex: 1, actionIndex: 1 }), plainStyle)

    expect(joined(onList)).not.toContain(ADD_HINT)
    expect(joined(onAdd)).toContain(ADD_HINT)
  })

  test('an intro that fills the pane is cut so the hint still lands on the last row', () => {
    const short: TerminalSize = { columns: 80, rows: 8 }

    const lines = render(mainModel({ sectionIndex: 1, actionIndex: 1 }, short), plainStyle)

    expect(paneOf(lines[short.rows - FOOTER_ROWS - 1])).toBe(ADD_HINT)
    expect(paneOf(lines[short.rows - FOOTER_ROWS - 2])).toBe('')
    expect(lines.every((line) => line.length === short.columns)).toBe(true)
  })
})

/**
 * Owner tail Q22: while a run is in flight the keyboard answers nothing but
 * Ctrl-C, which on a slow command reads as a wedged console unless the footer
 * says so.
 */
describe('render: the footer of a run in flight', () => {
  test('names the one key that still works', () => {
    const busy: RunRequest = { actionId: 'list', argv: ['admin', 'list'], display: ['admin', 'list'] }

    const lines = render(mainModel({ busy, sectionIndex: 1 }), plainStyle)

    expect(lines.at(-1)).toBe(padRight(RUNNING_HELP_FOOTER, DEFAULT_SIZE.columns))
    expect(RUNNING_HELP_FOOTER).toContain('Ctrl-C')
    expect(RUNNING_HELP_FOOTER).toContain('queued')
  })
})

/**
 * Owner tail Q24: a pane 54 columns wide cut `server list` at the right edge
 * and said nothing about it. The markers admit the cut; `[` and `]` move past
 * it.
 */
describe('render: an output wider than its pane', () => {
  const WIDE_LINE = 'w'.repeat(90)

  function widePanel(): OutputPanel {
    return panelOf(`${WIDE_LINE}\n`)
  }

  test('marks a clipped line in the last column of the pane', () => {
    const lines = render(mainModel({ output: widePanel() }), plainStyle)

    expect(lines[HEADER_ROWS + 1]?.at(-1)).toBe(OUTPUT_CLIP_MARKER)
    expect(lines[HEADER_ROWS + 1]?.length).toBe(DEFAULT_SIZE.columns)
  })

  test('a line that fits carries no marker', () => {
    const lines = render(mainModel({ output: panelOf('alice owner\n') }), plainStyle)
    // Only the body: the tab bar's own overflow marker is the same character.
    const pane = lines.slice(HEADER_ROWS, -FOOTER_ROWS).map(paneOf)

    expect(lines[HEADER_ROWS + 1]?.at(-1)).toBe(' ')
    expect(pane.some((line) => line.includes(OUTPUT_CLIP_MARKER))).toBe(false)
    expect(pane.some((line) => line.includes(OUTPUT_CLIP_LEFT_MARKER))).toBe(false)
  })

  test('a line cut on the left says so in the first column of the pane', () => {
    const output: OutputPanel = { ...widePanel(), hScroll: OUTPUT_HSCROLL_STEP }

    const lines = render(mainModel({ output }), plainStyle)
    const row = lines[HEADER_ROWS + 1] ?? ''

    expect(row[PANE_START]).toBe(OUTPUT_CLIP_LEFT_MARKER)
    expect(row.at(-1)).toBe(OUTPUT_CLIP_MARKER)
    expect(row).toHaveLength(DEFAULT_SIZE.columns)
  })

  test('scrolled far enough, the end of the line is on screen and nothing is cut on the right', () => {
    const output: OutputPanel = { ...widePanel(), hScroll: WIDE_LINE.length - PANE_WIDTH }

    const row = render(mainModel({ output }), plainStyle)[HEADER_ROWS + 1] ?? ''

    expect(row[PANE_START]).toBe(OUTPUT_CLIP_LEFT_MARKER)
    expect(row.at(-1)).toBe('w')
  })

  test('the footer offers the two keys only while something is cut', () => {
    const cut = render(mainModel({ output: widePanel() }), plainStyle)
    const whole = render(mainModel({ output: panelOf('alice owner\n') }), plainStyle)

    expect(cut.at(-1)).toBe(padRight(CLIPPED_HELP_FOOTER, DEFAULT_SIZE.columns))
    expect(whole.at(-1)).toBe(padRight(KEY_HELP_FOOTER, DEFAULT_SIZE.columns))
  })

  test('a pane scrolled sideways offers the keys even when every line now fits', () => {
    const output: OutputPanel = { ...panelOf('alice owner\n'), hScroll: OUTPUT_HSCROLL_STEP }

    const lines = render(mainModel({ output }), plainStyle)

    expect(lines.at(-1)).toBe(padRight(CLIPPED_HELP_FOOTER, DEFAULT_SIZE.columns))
  })

  test('both footers fit the terminal every emulator starts at', () => {
    expect(CLIPPED_HELP_FOOTER.length).toBeLessThanOrEqual(DEFAULT_SIZE.columns)
    expect(RUNNING_HELP_FOOTER.length).toBeLessThanOrEqual(DEFAULT_SIZE.columns)
  })
})

describe('render: styles are decoration only', () => {
  test('the styled main frame strips back to the plain one', () => {
    const model = mainModel({ output: numberedOutput(40), sectionIndex: 1, actionIndex: 1 })

    expect(render(model, ansiStyle).map(stripSgr)).toEqual(render(model, plainStyle))
  })

  test('the styled sign-in frame strips back to the plain one', () => {
    const model = signinModel('mcpa_secret')

    expect(render(model, ansiStyle).map(stripSgr)).toEqual(render(model, plainStyle))
  })
})

describe('render: what a short terminal and untrusted text must not break', () => {
  test('the action column scrolls so the selected action is on screen', () => {
    const lines = render(
      mainModel({ sectionIndex: 1, actionIndex: 4 }, { columns: 80, rows: 8 }),
      plainStyle,
    )

    expect(lines.some((line) => line.includes('▸ remove'))).toBe(true)
  })

  test('the form title comes from the pane, not from where the cursor happens to be', () => {
    const rotate = adminAction('rotate')
    const pane: Pane = { kind: 'form', actionId: 'rotate', form: formOf(rotate.fields) }

    const lines = render(mainModel({ sectionIndex: 1, actionIndex: 1, pane }), plainStyle)

    expect(lines[HEADER_ROWS]?.slice(ACTION_COLUMN_WIDTH + COLUMN_GAP).trimEnd()).toBe('rotate')
  })

  test('the quit question is asked above the output it is about, token line included', () => {
    const output = panelOf('token: mcpa_abc\nSave this token now: it cannot be recovered or shown again.')

    const lines = render(mainModel({ pane: { kind: 'quit-confirm' }, output }), plainStyle)

    expect(lines.some((line) => line.includes('Quit anyway? [y/N]'))).toBe(true)
    expect(lines.some((line) => line.includes('token: mcpa_abc'))).toBe(true)
  })

  test('an 8-bit escape pasted into a field never reaches the frame', () => {
    const action = adminAction('add')
    const form = typed(formOf(action.fields), 'bo\u009b2Jb')

    const lines = render(
      mainModel({ sectionIndex: 1, actionIndex: 1, pane: { kind: 'form', actionId: 'add', form } }),
      plainStyle,
    )

    expect(lines.some((line) => line.includes('\u009b'))).toBe(false)
    expect(joined(lines)).toContain('[bob')
  })

  test('a bidi override in a service host never reaches the frame', () => {
    const services: ServiceSummary[] = [
      { service: 'ui', state: 'running', host: 'safe\u202ehost', port: 8091 },
    ]

    const lines = render(mainModel({ services }), plainStyle)

    expect(lines.some((line) => line.includes('\u202e'))).toBe(false)
    expect(lines[0]).toContain('safehost')
  })
})
