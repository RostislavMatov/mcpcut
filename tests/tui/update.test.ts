import { describe, expect, test } from 'vitest'
import type { Role } from '../../src/admin/authz.js'
import type { TokenAdmin } from '../../src/cli/admin-token.js'
import { visibleSections } from '../../src/tui/catalogue/index.js'
import type { ActionSpec, SectionSpec } from '../../src/tui/catalogue/types.js'
import {
  ACTION_COLUMN_WIDTH,
  COLUMN_GAP,
  EXIT_OK,
  FOOTER_ROWS,
  HEADER_ROWS,
  ONE_TIME_TOKEN_MARKER,
  SECRET_DISPLAY_MASK,
  SESSION_LOST_NOTICE,
  SIGNIN_UNKNOWN_TOKEN_NOTICE,
} from '../../src/tui/constants.js'
import type { KeyEvent, NamedKey } from '../../src/tui/keys.js'
import {
  initialModel,
  mainScreenOf,
  type Effect,
  type Model,
  type Msg,
  type RunRequest,
  type Screen,
  type Session,
  type Step,
  type TerminalSize,
} from '../../src/tui/model.js'
import {
  OUTPUT_HSCROLL_STEP,
  outputPanelOf,
  type OutputPanel,
  type RunResult,
} from '../../src/tui/output.js'
import type { ServiceSummary } from '../../src/tui/services-summary.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import { update } from '../../src/tui/update.js'
import { requestOf, stdinOf } from '../../src/tui/update-form.js'
import { EMPTY_TOKEN_NOTICE } from '../../src/tui/update-signin.js'
import { wizardScreenOf } from '../../src/tui/wizard-fields.js'

/**
 * The reducer is the whole of the console's behaviour: every keystroke, every
 * answer from an effect, and every exit path is one pure `(model, msg) → step`
 * away from a frame. Nothing here touches a terminal, a store or a clock, so
 * each case below is the AAA triple it looks like.
 *
 * Two invariants get their own tables at the end. Nothing mutates the model it
 * was handed (a reducer that did would let a stale frame and the next step
 * disagree), and nothing on the sign-in screen answers a message meant for a
 * session that has already ended (the race after `session-lost`).
 */

const SIZE: TerminalSize = { columns: 80, rows: 24 }

/** Stdout of a command that minted a token: what makes `q` ask before quitting. */
const ONE_TIME_STDOUT = `token: mcpa_x\n${ONE_TIME_TOKEN_MARKER}\n`
const SESSION: Session = { adminName: 'root', role: 'owner' }

/**
 * Index of the sections an owner sees, in the order the tab bar shows them:
 * home, admins, servers, vault, agents, groups, policy, quarantine,
 * approvals, journal, audit. Only the first nine have a digit key — `10` and
 * `11` cannot be typed as one keystroke, so Audit is reached by Tab alone.
 */
const HOME_TAB = 0
const ADMINS_TAB = 1
const SERVERS_TAB = 2
const VAULT_TAB = 3
const APPROVALS_TAB = 8
const JOURNAL_TAB = 9
const AUDIT_TAB = 10

/** What the catalogue sections are called, in that same order. */
const OWNER_SECTION_IDS: readonly string[] = [
  'home',
  'admins',
  'servers',
  'vault',
  'agents',
  'groups',
  'policy',
  'quarantine',
  'approvals',
  'journal',
  'audit',
]

/** The sections a viewer sees: the owner's list without Admins and Vault. */
const VIEWER_SECTION_IDS: readonly string[] = OWNER_SECTION_IDS.filter(
  (id) => id !== 'admins' && id !== 'vault',
)

/** An index past the last section: what a cursor left over from another role looks like. */
const NO_SUCH_TAB = OWNER_SECTION_IDS.length

/** Index of the actions the cases below open by their position in a section. */
const VAULT_SET_ACTION = 2
const JOURNAL_EXPORT_ACTION = 2
const AUDIT_PRUNE_ACTION = 6

/** A vault value: long enough that finding it in a frame could not be a coincidence. */
const VAULT_SECRET = 'sk-live-do-not-print-me'

type MainScreen = Extract<Screen, { kind: 'main' }>
type SigninScreen = Extract<Screen, { kind: 'signin' }>

function key(kind: NamedKey): Msg {
  return { kind: 'key', key: { kind } as KeyEvent }
}

function char(value: string): Msg {
  return { kind: 'key', key: { kind: 'char', char: value } }
}

function ctrl(value: string): Msg {
  return { kind: 'key', key: { kind: 'ctrl', char: value } }
}

function typed(model: Model, text: string): Model {
  return [...text].reduce((current, letter) => update(current, char(letter)).model, model)
}

function mainScreen(patch: Partial<MainScreen> = {}, role: Role = 'owner'): MainScreen {
  const screen = mainScreenOf({ ...SESSION, role }, visibleSections(role))
  if (screen.kind !== 'main') throw new Error('mainScreenOf must build a main screen')

  return { ...screen, ...patch }
}

function mainModel(patch: Partial<MainScreen> = {}, role: Role = 'owner'): Model {
  return { screen: mainScreen(patch, role), size: SIZE }
}

/**
 * A wizard on its form. The stage-by-stage behaviour is asserted in
 * `update-wizard.test.ts`; what belongs here is that `update` routes to it and
 * that its branches keep the invariants the other screens keep.
 */
function wizardModel(): Model {
  const config = defaultInstallConfig('/var/lib/x')
  const screen = wizardScreenOf({ mode: 'first-run', configPath: '/home/op/.mcpcut/config.json', config })

  return { screen, size: SIZE }
}

function mainOf(model: Model): MainScreen {
  if (model.screen.kind !== 'main') throw new Error(`expected a main screen, got ${model.screen.kind}`)

  return model.screen
}

function signinOf(model: Model): SigninScreen {
  if (model.screen.kind !== 'signin') throw new Error(`expected a sign-in screen, got ${model.screen.kind}`)

  return model.screen
}

function panelOf(lineCount: number, overrides: Partial<RunResult> = {}): OutputPanel {
  const stdout = Array.from({ length: lineCount }, (_, index) => `line ${index}`).join('\n')
  return outputPanelOf({
    argv: ['admin', 'list'],
    display: ['admin', 'list'],
    exitCode: 0,
    stdout,
    stderr: '',
    ...overrides,
  })
}

/** A section with no refresh action, to pin the other half of the `r` rule. */
const PLAIN_SECTION: SectionSpec = {
  id: 'plain',
  title: 'Plain',
  minRole: 'viewer',
  intro: ['nothing to refresh here'],
  actions: [
    {
      id: 'noop',
      title: 'noop',
      minRole: 'viewer',
      command: 'status',
      fields: [],
      argv: () => ['status'],
    },
  ],
}

/**
 * A deep copy that keeps functions by reference: the catalogue carries `argv`
 * builders and field validators, which `structuredClone` refuses outright.
 */
function snapshotOf<T>(value: T): T {
  if (Array.isArray(value)) return value.map(snapshotOf) as unknown as T
  if (value === null || typeof value !== 'object') return value

  return Object.fromEntries(Object.entries(value).map(([name, each]) => [name, snapshotOf(each)])) as T
}

/**
 * Freezes a model in place instead of cloning it: the catalogue carries `argv`
 * builders and field validators, which `structuredClone` refuses, while a
 * frozen object turns any in-place write into a `TypeError` under the module's
 * strict mode — a stricter check than comparing a copy afterwards.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const each of Object.values(value)) deepFreeze(each)

  return Object.freeze(value)
}

describe('update: the entry point', () => {
  test('resize replaces the size and leaves the screen alone', () => {
    const model = mainModel()

    const step = update(model, { kind: 'resize', size: { columns: 40, rows: 10 } })

    expect(step.model.size).toEqual({ columns: 40, rows: 10 })
    expect(step.model.screen).toBe(model.screen)
    expect(step.effects).toEqual([])
  })

  test('resize applies while a run is in flight', () => {
    const busy: RunRequest = { actionId: 'list', argv: ['admin', 'list'], display: ['admin', 'list'] }

    const step = update(mainModel({ busy }), { kind: 'resize', size: { columns: 100, rows: 50 } })

    expect(step.model.size).toEqual({ columns: 100, rows: 50 })
    expect(mainOf(step.model).busy).toEqual(busy)
  })

  test('Ctrl-C quits from the sign-in screen', () => {
    const step = update(initialModel(SIZE), ctrl('c'))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
  })

  test('Ctrl-C quits from the main screen', () => {
    const step = update(mainModel(), ctrl('c'))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
  })

  test('Ctrl-C quits even while a run is in flight', () => {
    const busy: RunRequest = { actionId: 'list', argv: ['admin', 'list'], display: ['admin', 'list'] }

    const step = update(mainModel({ busy }), ctrl('c'))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
  })

  test('another Ctrl combination is not a quit', () => {
    const step = update(mainModel(), ctrl('d'))

    expect(step.effects).toEqual([])
  })

  test('every other key is ignored while a run is in flight', () => {
    const busy: RunRequest = { actionId: 'list', argv: ['admin', 'list'], display: ['admin', 'list'] }
    const model = mainModel({ busy })

    for (const msg of [key('enter'), char('q'), char('2'), key('down'), char('r')]) {
      const step = update(model, msg)

      expect(step.model).toBe(model)
      expect(step.effects).toEqual([])
    }
  })
})

describe('update: the sign-in screen', () => {
  test('a printable key reaches the token field', () => {
    const step = update(initialModel(SIZE), char('m'))

    expect(signinOf(step.model).form.fields[0]?.value).toBe('m')
    expect(step.effects).toEqual([])
  })

  test('backspace removes the last character', () => {
    const model = typed(initialModel(SIZE), 'ab')

    const step = update(model, key('backspace'))

    expect(signinOf(step.model).form.fields[0]?.value).toBe('a')
  })

  test('a key the field has no use for leaves the model untouched', () => {
    const model = initialModel(SIZE)

    const step = update(model, key('right'))

    expect(step.model).toBe(model)
  })

  test('Enter with an empty token asks for one instead of signing in', () => {
    const step = update(initialModel(SIZE), key('enter'))

    expect(signinOf(step.model).notice).toBe(EMPTY_TOKEN_NOTICE)
    expect(signinOf(step.model).busy).toBe(false)
    expect(step.effects).toEqual([])
  })

  test('Enter with a token asks the runtime to sign in and clears the field', () => {
    const model = typed(initialModel(SIZE), 'mcpa_secret')

    const step = update(model, key('enter'))

    expect(step.effects).toEqual([{ kind: 'signin', token: 'mcpa_secret' }])
    expect(signinOf(step.model).form.fields[0]?.value).toBe('')
    expect(signinOf(step.model).busy).toBe(true)
    expect(signinOf(step.model).notice).toBeUndefined()
  })

  test('the token is taken exactly as typed, spaces included', () => {
    const model = typed(initialModel(SIZE), ' mcpa_x ')

    const step = update(model, key('enter'))

    expect(step.effects).toEqual([{ kind: 'signin', token: ' mcpa_x ' }])
  })

  test('Escape quits', () => {
    const step = update(initialModel(SIZE), key('escape'))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
  })

  test('a resolved token opens the main screen and asks for the service line', () => {
    const result: TokenAdmin = { kind: 'ok', name: 'root', role: 'owner' }

    const step = update(initialModel(SIZE), { kind: 'signin-result', result })

    const screen = mainOf(step.model)
    expect(screen.session).toEqual({ adminName: 'root', role: 'owner' })
    expect(screen.sections).toEqual(visibleSections('owner'))
    expect(screen.pane).toEqual({ kind: 'actions' })
    expect(step.effects).toEqual([{ kind: 'refresh-services' }])
  })

  test('a viewer sees only the sections a viewer may use', () => {
    const result: TokenAdmin = { kind: 'ok', name: 'reader', role: 'viewer' }

    const step = update(initialModel(SIZE), { kind: 'signin-result', result })

    expect(mainOf(step.model).sections.map((section) => section.id)).toEqual(VIEWER_SECTION_IDS)
  })

  test('an owner sees the whole catalogue, in catalogue order', () => {
    const result: TokenAdmin = { kind: 'ok', name: 'root', role: 'owner' }

    const step = update(initialModel(SIZE), { kind: 'signin-result', result })

    expect(mainOf(step.model).sections.map((section) => section.id)).toEqual(OWNER_SECTION_IDS)
  })

  test.each([
    ['unknown' as const],
    ['missing' as const],
  ])('a %s token says so without saying which', (kind) => {
    const step = update(initialModel(SIZE), { kind: 'signin-result', result: { kind } })

    expect(signinOf(step.model).notice).toBe(SIGNIN_UNKNOWN_TOKEN_NOTICE)
    expect(signinOf(step.model).busy).toBe(false)
    expect(step.effects).toEqual([])
  })

  test('an unreadable store shows what went wrong with it', () => {
    const result: TokenAdmin = { kind: 'unreadable', detail: 'admins.json: unexpected token' }

    const step = update(initialModel(SIZE), { kind: 'signin-result', result })

    expect(signinOf(step.model).notice).toBe('admins.json: unexpected token')
    expect(signinOf(step.model).busy).toBe(false)
  })

  test.each([
    [
      'run-result',
      {
        kind: 'run-result',
        result: { argv: ['admin', 'list'], display: ['admin', 'list'], exitCode: 0, stdout: 'x', stderr: '' },
      } satisfies Msg,
    ],
    ['services', { kind: 'services', statuses: [] } satisfies Msg],
    ['session-lost', { kind: 'session-lost' } satisfies Msg],
  ])('%s is ignored on the sign-in screen', (_name, msg) => {
    const model = initialModel(SIZE)

    const step = update(model, msg)

    expect(step.model).toBe(model)
    expect(step.effects).toEqual([])
  })
})

describe('update: moving between sections', () => {
  test.each([
    ['tab', key('tab')],
    ['right', key('right')],
    ['l', char('l')],
  ])('%s moves to the next section', (_name, msg) => {
    const step = update(mainModel(), msg)

    expect(mainOf(step.model).sectionIndex).toBe(ADMINS_TAB)
  })

  test.each([
    ['backtab', key('backtab')],
    ['left', key('left')],
    ['h', char('h')],
  ])('%s moves to the previous section, wrapping past the first', (_name, msg) => {
    const step = update(mainModel(), msg)

    expect(mainOf(step.model).sectionIndex).toBe(AUDIT_TAB)
  })

  test('the next section wraps past the last', () => {
    const step = update(mainModel({ sectionIndex: AUDIT_TAB }), key('tab'))

    expect(mainOf(step.model).sectionIndex).toBe(HOME_TAB)
  })

  test('switching sections puts the cursor on the first action', () => {
    const step = update(mainModel({ sectionIndex: ADMINS_TAB, actionIndex: 3 }), key('tab'))

    expect(mainOf(step.model).actionIndex).toBe(0)
  })

  test('a digit jumps straight to a section', () => {
    const step = update(mainModel({ actionIndex: 2 }), char('2'))

    expect(mainOf(step.model).sectionIndex).toBe(ADMINS_TAB)
    expect(mainOf(step.model).actionIndex).toBe(0)
  })

  test.each([
    ['3', 'servers'],
    ['9', 'approvals'],
  ])('the digit %s jumps to the %s section', (digit, id) => {
    const step = update(mainModel({ sectionIndex: HOME_TAB }), char(digit))

    const screen = mainOf(step.model)
    expect(screen.sections[screen.sectionIndex]?.id).toBe(id)
  })

  test('the tenth and eleventh sections have no digit and are reached by Tab alone', () => {
    const step = update(mainModel({ sectionIndex: JOURNAL_TAB }), key('tab'))

    expect(mainOf(step.model).sectionIndex).toBe(AUDIT_TAB)
  })

  test('the digit 0 names no section and changes nothing', () => {
    const model = mainModel({ sectionIndex: ADMINS_TAB, actionIndex: 2 })

    const step = update(model, char('0'))

    expect(step.model).toBe(model)
  })

  test('a digit past the sections on screen changes nothing', () => {
    const model = mainModel({ sections: [PLAIN_SECTION] })

    const step = update(model, char('9'))

    expect(step.model).toBe(model)
  })

  test('a section switch requests nothing of the runtime', () => {
    expect(update(mainModel(), char('2')).effects).toEqual([])
  })
})

describe('update: moving between actions', () => {
  test.each([
    ['down', key('down')],
    ['j', char('j')],
  ])('%s moves to the next action', (_name, msg) => {
    const step = update(mainModel({ sectionIndex: ADMINS_TAB }), msg)

    expect(mainOf(step.model).actionIndex).toBe(1)
  })

  test.each([
    ['up', key('up')],
    ['k', char('k')],
  ])('%s moves to the previous action', (_name, msg) => {
    const step = update(mainModel({ sectionIndex: ADMINS_TAB, actionIndex: 2 }), msg)

    expect(mainOf(step.model).actionIndex).toBe(1)
  })

  test('the cursor stops at the last action instead of wrapping', () => {
    const model = mainModel({ sectionIndex: ADMINS_TAB, actionIndex: 4 })

    const step = update(model, key('down'))

    expect(step.model).toBe(model)
  })

  test('the cursor stops at the first action', () => {
    const model = mainModel({ sectionIndex: ADMINS_TAB })

    const step = update(model, key('up'))

    expect(step.model).toBe(model)
  })

  test('a section index outside the list clamps to the first action rather than dividing by zero', () => {
    const model = mainModel({ sectionIndex: NO_SUCH_TAB, actionIndex: 3 })

    expect(mainOf(update(model, key('down')).model).actionIndex).toBe(0)
    expect(mainOf(update(model, key('up')).model).actionIndex).toBe(0)
  })
})

describe('update: running an action', () => {
  test('Enter on an action with no fields runs it at once', () => {
    const step = update(mainModel({ sectionIndex: ADMINS_TAB }), key('enter'))

    const request: RunRequest = {
      actionId: 'list',
      argv: ['admin', 'list'],
      display: ['admin', 'list'],
    }
    expect(step.effects).toEqual([{ kind: 'run', request }])
    expect(mainOf(step.model).busy).toEqual(request)
    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
  })

  test('Enter on an action with fields opens its form', () => {
    const step = update(mainModel({ sectionIndex: ADMINS_TAB, actionIndex: 1 }), key('enter'))

    const pane = mainOf(step.model).pane
    expect(pane.kind).toBe('form')
    if (pane.kind !== 'form') throw new Error('expected a form pane')
    expect(pane.actionId).toBe('add')
    expect(pane.form.fields.map((field) => field.spec.name)).toEqual(['name', 'role'])
    expect(step.effects).toEqual([])
  })

  test('Enter with the cursor outside the catalogue does nothing', () => {
    const model = mainModel({ sectionIndex: ADMINS_TAB, actionIndex: NO_SUCH_TAB })

    const step = update(model, key('enter'))

    expect(step.model).toBe(model)
    expect(step.effects).toEqual([])
  })

  test('a finished run replaces the output and clears the run in flight', () => {
    const busy: RunRequest = { actionId: 'list', argv: ['admin', 'list'], display: ['admin', 'list'] }
    const result: RunResult = {
      argv: ['admin', 'list'],
      display: ['admin', 'list'],
      exitCode: 0,
      stdout: 'alice owner\n',
      stderr: '',
    }

    const step = update(mainModel({ busy, pane: { kind: 'help' } }), { kind: 'run-result', result })

    const screen = mainOf(step.model)
    expect(screen.output?.lines).toEqual(['alice owner'])
    expect(screen.pane).toEqual({ kind: 'actions' })
    expect('busy' in screen).toBe(false)
    expect(step.effects).toEqual([])
  })

  test('a service answer replaces the header line', () => {
    const statuses: readonly ServiceSummary[] = [
      { service: 'ui', state: 'running', host: '127.0.0.1', port: 8091 },
    ]

    const step = update(mainModel(), { kind: 'services', statuses })

    expect(mainOf(step.model).services).toEqual(statuses)
  })

  test('an unknown service answer leaves the header without a line at all', () => {
    const statuses: readonly ServiceSummary[] = [
      { service: 'ui', state: 'running', host: '127.0.0.1', port: 8091 },
    ]

    const step = update(mainModel({ services: statuses }), { kind: 'services', statuses: undefined })

    expect('services' in mainOf(step.model)).toBe(false)
  })

  test('a sign-in answer is ignored on the main screen', () => {
    const model = mainModel()

    const step = update(model, { kind: 'signin-result', result: { kind: 'ok', name: 'x', role: 'owner' } })

    expect(step.model).toBe(model)
  })

  test('a lost session returns to a fresh sign-in screen that says so', () => {
    const step = update(mainModel({ output: panelOf(3) }), { kind: 'session-lost' })

    const screen = signinOf(step.model)
    expect(screen.notice).toBe(SESSION_LOST_NOTICE)
    expect(screen.busy).toBe(false)
    expect(screen.form.fields[0]?.value).toBe('')
    expect(step.model.size).toEqual(SIZE)
    expect(step.effects).toEqual([])
  })
})

describe('update: the r key', () => {
  test('Admins reruns admin list and the service line', () => {
    const step = update(mainModel({ sectionIndex: ADMINS_TAB, actionIndex: 3 }), char('r'))

    const request: RunRequest = {
      actionId: 'list',
      argv: ['admin', 'list'],
      display: ['admin', 'list'],
    }
    expect(step.effects).toEqual([{ kind: 'run', request }, { kind: 'refresh-services' }])
    expect(mainOf(step.model).busy).toEqual(request)
    expect(mainOf(step.model).actionIndex).toBe(3)
  })

  test.each([
    ['Servers', SERVERS_TAB, ['server', 'list']],
    ['Approvals', APPROVALS_TAB, ['approvals', 'list']],
  ])('%s reruns its own list and the service line', (_name, sectionIndex, argv) => {
    const step = update(mainModel({ sectionIndex }), char('r'))

    const request: RunRequest = { actionId: 'list', argv, display: argv }
    expect(step.effects).toEqual([{ kind: 'run', request }, { kind: 'refresh-services' }])
    expect(mainOf(step.model).busy).toEqual(request)
  })

  test('Home reruns status and the service line', () => {
    const step = update(mainModel(), char('r'))

    const request: RunRequest = { actionId: 'status', argv: ['status'], display: ['status'] }
    expect(step.effects).toEqual([{ kind: 'run', request }, { kind: 'refresh-services' }])
  })

  test('a section with no refresh action refreshes only the service line', () => {
    const model = mainModel({ sections: [PLAIN_SECTION] })

    const step = update(model, char('r'))

    expect(step.effects).toEqual([{ kind: 'refresh-services' }])
    expect(step.model).toBe(model)
  })

  test('a section outside the list refreshes only the service line', () => {
    const step = update(mainModel({ sectionIndex: NO_SUCH_TAB }), char('r'))

    expect(step.effects).toEqual([{ kind: 'refresh-services' }])
  })
})

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
    const output = panelOf(1, { stdout: ONE_TIME_STDOUT })
    expect(output.holdsOneTimeToken).toBe(true)

    const step = update(mainModel({ output }), char('q'))

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
})

describe('update: a form pane', () => {
  function formModel(actionIndex: number): Model {
    return update(mainModel({ sectionIndex: ADMINS_TAB, actionIndex }), key('enter')).model
  }

  test.each([
    ['Tab', key('tab')],
    ['down', key('down')],
  ])('%s moves to the next field', (_name, msg) => {
    const step = update(formModel(1), msg)

    const pane = mainOf(step.model).pane
    expect(pane.kind === 'form' ? pane.form.focus : -1).toBe(1)
  })

  test.each([
    ['Shift-Tab', key('backtab')],
    ['up', key('up')],
  ])('%s moves to the previous field, wrapping', (_name, msg) => {
    const step = update(formModel(1), msg)

    const pane = mainOf(step.model).pane
    expect(pane.kind === 'form' ? pane.form.focus : -1).toBe(1)
  })

  test('a printable key edits the focused field', () => {
    const step = update(formModel(1), char('b'))

    const pane = mainOf(step.model).pane
    expect(pane.kind === 'form' ? pane.form.fields[0]?.value : undefined).toBe('b')
  })

  test('a form whose action is no longer reachable closes instead of running', () => {
    const opened = formModel(1)
    const orphaned = mainModel({ pane: mainOf(opened).pane, sectionIndex: NO_SUCH_TAB })

    const step = update(typed(orphaned, 'bob'), key('enter'))

    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
    expect(step.effects).toEqual([])
  })

  test('Escape closes the form without running anything', () => {
    const step = update(formModel(1), key('escape'))

    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
    expect(step.effects).toEqual([])
  })

  test('Enter on an invalid value keeps the form and shows the error', () => {
    const step = update(typed(formModel(1), 'Bad Name'), key('enter'))

    const pane = mainOf(step.model).pane
    if (pane.kind !== 'form') throw new Error('expected a form pane')
    expect(pane.form.fields[0]?.error).toContain('must match')
    expect(pane.form.focus).toBe(0)
    expect(step.effects).toEqual([])
  })

  test('Enter on an empty required value keeps the form', () => {
    const step = update(formModel(1), key('enter'))

    const pane = mainOf(step.model).pane
    expect(pane.kind === 'form' ? pane.form.fields[0]?.error : undefined).toBe('required')
  })

  test('Enter on a valid form runs the command the form builds', () => {
    const step = update(typed(formModel(1), 'bob'), key('enter'))

    const request: RunRequest = {
      actionId: 'add',
      argv: ['admin', 'add', 'bob', '--role', 'owner'],
      display: ['admin', 'add', 'bob', '--role', 'owner'],
    }
    expect(step.effects).toEqual([{ kind: 'run', request }])
    expect(mainOf(step.model).busy).toEqual(request)
    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
  })

  test('the arrows pick a role before the command is built', () => {
    const named = typed(formModel(1), 'bob')
    const onRole = update(named, key('tab')).model

    const step = update(update(onRole, key('right')).model, key('enter'))

    expect(step.effects).toEqual([
      {
        kind: 'run',
        request: {
          actionId: 'add',
          argv: ['admin', 'add', 'bob', '--role', 'operator'],
          display: ['admin', 'add', 'bob', '--role', 'operator'],
        },
      },
    ])
  })

  test('the displayed command line is a copy, not the argv that was dispatched', () => {
    const step = update(typed(formModel(1), 'bob'), key('enter'))

    const effect = step.effects[0]
    if (effect?.kind !== 'run') throw new Error('expected a run effect')
    expect(effect.request.display).not.toBe(effect.request.argv)
  })
})

describe('update: a confirmation pane', () => {
  function confirmModel(): Model {
    const form = update(mainModel({ sectionIndex: ADMINS_TAB, actionIndex: 4 }), key('enter')).model
    return update(typed(form, 'bob'), key('enter')).model
  }

  test('an action that asks first opens a question instead of running', () => {
    const model = confirmModel()

    const pane = mainOf(model).pane
    if (pane.kind !== 'confirm') throw new Error('expected a confirm pane')
    expect(pane.actionId).toBe('remove')
    expect(pane.question).toContain('Remove admin "bob"?')
    expect(pane.request.argv).toEqual(['admin', 'remove', 'bob'])
  })

  test.each([['y'], ['Y']])('%s runs the command that was asked about', (answer) => {
    const model = confirmModel()

    const step = update(model, char(answer))

    const request: RunRequest = {
      actionId: 'remove',
      argv: ['admin', 'remove', 'bob'],
      display: ['admin', 'remove', 'bob'],
    }
    expect(step.effects).toEqual([{ kind: 'run', request }])
    expect(mainOf(step.model).busy).toEqual(request)
  })

  test('any other answer cancels', () => {
    const step = update(confirmModel(), char('n'))

    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
    expect(step.effects).toEqual([])
  })

  test('Escape cancels too', () => {
    const step = update(confirmModel(), key('escape'))

    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
    expect(step.effects).toEqual([])
  })
})

describe('update: what a run carries besides its argv', () => {
  /** A synthetic action, so the shape being asserted is visible in the test. */
  const signAction: ActionSpec = {
    id: 'sign',
    title: 'sign',
    minRole: 'owner',
    command: 'demo',
    fields: [
      { name: 'name', label: 'Name', kind: 'text' },
      { name: 'token', label: 'Token', kind: 'secret' },
    ],
    argv: (values) => ['demo', values.name ?? '', '--token', values.token ?? ''],
  }

  /** Opens one action's form and returns the model showing it. */
  function formModel(sectionIndex: number, actionIndex: number): Model {
    return update(mainModel({ sectionIndex, actionIndex }), key('enter')).model
  }

  /** Types a value into the focused field and moves on to the next one. */
  function filled(model: Model, value: string): Model {
    return update(typed(model, value), key('tab')).model
  }

  /** The one run effect a submit is expected to have asked for. */
  function runEffectOf(step: Step): Extract<Effect, { kind: 'run' }> {
    const effect = step.effects[0]
    if (effect?.kind !== 'run') throw new Error(`expected a run effect, got ${effect?.kind ?? 'none'}`)

    return effect
  }

  test('a secret that reaches argv is masked in the displayed command line only', () => {
    // Arrange
    const values = { name: 'bob', token: 'mcpa_secret' }

    // Act
    const request = requestOf(signAction, values)

    // Assert
    expect(request.argv).toEqual(['demo', 'bob', '--token', 'mcpa_secret'])
    expect(request.display).toEqual(['demo', 'bob', '--token', SECRET_DISPLAY_MASK])
  })

  test('an empty secret masks nothing, so an empty argument stays an empty argument', () => {
    const request = requestOf(signAction, { name: '', token: '' })

    expect(request.display).toEqual(['demo', '', '--token', ''])
  })

  test('a padded value reaches the command line trimmed, so no file is named " out"', () => {
    // Arrange: a stray space is what a paste and an arrow key leave behind.
    const values = { name: '  bob  ', token: 'mcpa_secret' }

    // Act
    const request = requestOf(signAction, values)

    // Assert
    expect(request.argv).toEqual(['demo', 'bob', '--token', 'mcpa_secret'])
  })

  test('a secret is handed over exactly as typed: its own padding may be part of it', () => {
    const request = requestOf(signAction, { name: 'bob', token: '  mcpa_secret  ' })

    expect(request.argv).toEqual(['demo', 'bob', '--token', '  mcpa_secret  '])
    expect(request.display).toEqual(['demo', 'bob', '--token', SECRET_DISPLAY_MASK])
  })

  test('a padded output path is trimmed before the runtime opens the file', () => {
    // Arrange
    const writeAction: ActionSpec = {
      id: 'dump',
      title: 'dump',
      minRole: 'viewer',
      command: 'demo',
      fields: [{ name: 'out', label: 'Out', kind: 'text', required: true }],
      argv: () => ['demo'],
      stdoutToField: 'out',
    }

    // Act
    const request = requestOf(writeAction, { out: '  /tmp/journal.jsonl  ' })

    // Assert
    expect(request.stdoutPath).toBe('/tmp/journal.jsonl')
  })

  test('an output field holding only whitespace names no file at all', () => {
    const writeAction: ActionSpec = {
      id: 'dump',
      title: 'dump',
      minRole: 'viewer',
      command: 'demo',
      fields: [{ name: 'out', label: 'Out', kind: 'text' }],
      argv: () => ['demo'],
      stdoutToField: 'out',
    }

    expect('stdoutPath' in requestOf(writeAction, { out: '   ' })).toBe(false)
  })

  test('an action that names no output path leaves the key out of the request', () => {
    const request = requestOf(signAction, { name: 'bob', token: 'x' })

    expect('stdoutPath' in request).toBe(false)
  })

  test('an action that names no stdin field hands the runtime nothing to write', () => {
    expect(stdinOf(signAction, { name: 'bob', token: 'x' })).toBeUndefined()
  })

  test('the vault secret travels in the run effect and never enters the model', () => {
    // Arrange
    const named = filled(formModel(VAULT_TAB, VAULT_SET_ACTION), 'openai')
    const ready = typed(named, VAULT_SECRET)

    // Act
    const step = update(ready, key('enter'))

    // Assert
    const effect = runEffectOf(step)
    expect(effect.stdin).toBe(VAULT_SECRET)
    expect(effect.request.argv).toEqual(['vault', 'set', 'openai'])
    expect(mainOf(step.model).busy?.display).not.toContain(VAULT_SECRET)
    expect(JSON.stringify(step.model)).not.toContain(VAULT_SECRET)
  })

  test('journal export puts the path it was given on the request', () => {
    const ready = filled(formModel(JOURNAL_TAB, JOURNAL_EXPORT_ACTION), '/tmp/journal.jsonl')

    const step = update(ready, key('enter'))

    expect(runEffectOf(step).request.stdoutPath).toBe('/tmp/journal.jsonl')
  })

  test('a dry-run prune runs at once, because the flag it is off answers nothing', () => {
    const ready = filled(formModel(AUDIT_TAB, AUDIT_PRUNE_ACTION), '90d')

    const step = update(ready, key('enter'))

    expect(runEffectOf(step).request.argv).toEqual(['prune', '--older-than', '90d'])
    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
  })

  test('a prune that would delete asks before anything happens', () => {
    const ready = update(filled(formModel(AUDIT_TAB, AUDIT_PRUNE_ACTION), '90d'), char(' ')).model

    const step = update(ready, key('enter'))

    const pane = mainOf(step.model).pane
    if (pane.kind !== 'confirm') throw new Error('expected a confirm pane')
    expect(pane.question).toContain('Delete journal records older than 90d?')
    expect(pane.request.argv).toEqual(['prune', '--older-than', '90d', '--yes'])
    expect(step.effects).toEqual([])
  })
})

describe('update: nothing mutates the model it was handed', () => {
  const request: RunRequest = { actionId: 'list', argv: ['admin', 'list'], display: ['admin', 'list'] }
  const runResult: RunResult = {
    argv: ['admin', 'list'],
    display: ['admin', 'list'],
    exitCode: 0,
    stdout: 'alice owner\n',
    stderr: '',
  }

  const cases: ReadonlyArray<readonly [string, Model, Msg]> = [
    ['sign-in: typing', initialModel(SIZE), char('m')],
    ['sign-in: Enter', typed(initialModel(SIZE), 'mcpa_x'), key('enter')],
    ['sign-in: resolved', initialModel(SIZE), { kind: 'signin-result', result: { kind: 'ok', name: 'root', role: 'owner' } }],
    ['sign-in: rejected', initialModel(SIZE), { kind: 'signin-result', result: { kind: 'unknown' } }],
    ['main: next section', mainModel(), key('tab')],
    ['main: next action', mainModel({ sectionIndex: ADMINS_TAB }), key('down')],
    ['main: run', mainModel({ sectionIndex: ADMINS_TAB }), key('enter')],
    ['main: open a form', mainModel({ sectionIndex: ADMINS_TAB, actionIndex: 1 }), key('enter')],
    ['main: refresh', mainModel({ sectionIndex: ADMINS_TAB }), char('r')],
    ['main: finished run', mainModel({ busy: request }), { kind: 'run-result', result: runResult }],
    ['main: services', mainModel(), { kind: 'services', statuses: [] }],
    ['main: session lost', mainModel({ output: panelOf(2) }), { kind: 'session-lost' }],
    ['main: scroll', mainModel({ output: panelOf(100) }), key('pagedown')],
    ['main: help', mainModel(), char('?')],
    ['main: quit question', mainModel({ output: panelOf(1, { stdout: ONE_TIME_STDOUT }) }), char('q')],
    ['main: resize', mainModel(), { kind: 'resize', size: { columns: 40, rows: 10 } }],
    ['wizard: typing', wizardModel(), char('z')],
    ['wizard: deploy', wizardModel(), key('enter')],
    [
      'wizard: finished step',
      update(wizardModel(), key('enter')).model,
      { kind: 'wizard-run-result', step: 'setup', result: { ...runResult, stdout: 'admin: owner\ntoken: mcpa_x\n' } },
    ],
  ]

  test.each(cases)('%s', (_name, model, msg) => {
    const before = snapshotOf(model)
    deepFreeze(model)

    update(model, msg)

    expect(model).toEqual(before)
  })
})

describe('update: one sign-in at a time', () => {
  test('a second Enter while the store is answering queues nothing', () => {
    const first = update(typed(initialModel({ columns: 80, rows: 24 }), 'mcpa_x'), key('enter'))
    expect(first.effects).toHaveLength(1)

    const second = update(first.model, key('enter'))

    expect(second.effects).toEqual([])
    expect(second.model).toEqual(first.model)
  })
})
