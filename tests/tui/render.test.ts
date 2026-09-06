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
import { outputPanelOf, type OutputPanel } from '../../src/tui/output.js'
import { render } from '../../src/tui/render.js'
import { SIGNIN_BUSY_TEXT, SIGNIN_FOOTER } from '../../src/tui/render-panes.js'
import { servicesHeaderPart, type ServiceSummary } from '../../src/tui/services-summary.js'
import { CLI_NAME } from '../../src/setup/constants.js'

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

function mainModel(patch: MainPatch = {}, size: TerminalSize = DEFAULT_SIZE): Model {
  return { screen: { ...mainBase(), ...patch }, size }
}

function typed(form: Form, text: string): Form {
  return [...text].reduce((current, char) => editFocused(current, { kind: 'char', char }), form)
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

  test('inverses the active tab only', () => {
    const lines = render(mainModel({ sectionIndex: 1 }), ansiStyle)

    expect(lines[1]).toContain(`\x1b[7m2 Admins\x1b[27m`)
    expect(lines[1]).not.toContain(`\x1b[7m1 Home\x1b[27m`)
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
