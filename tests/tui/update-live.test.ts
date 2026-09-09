import { describe, expect, test } from 'vitest'
import type { Role } from '../../src/admin/authz.js'
import { EXTERNAL_SUPERVISOR } from '../../src/services/constants.js'
import { visibleSections } from '../../src/tui/catalogue/index.js'
import type { SectionSpec } from '../../src/tui/catalogue/types.js'
import { APPROVALS_POLL_INTERVAL_MS } from '../../src/tui/constants-live.js'
import {
  EXIT_OK,
  FOOTER_ROWS,
  HEADER_ROWS,
  ONE_TIME_TOKEN_MARKER,
} from '../../src/tui/constants.js'
import type { KeyEvent, NamedKey } from '../../src/tui/keys.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import {
  DEFAULT_INSTALL_FACTS,
  initialModel,
  installFactsOf,
  mainScreenOf,
  type Model,
  type Msg,
  type RunRequest,
  type Screen,
  type Session,
  type TerminalSize,
} from '../../src/tui/model.js'
import { outputPanelOf, type OutputPanel, type RunResult } from '../../src/tui/output.js'
import type { ServiceSummary } from '../../src/tui/services-summary.js'
import { update } from '../../src/tui/update.js'

/**
 * The half of the reducer that answers messages nobody typed (mcpcut phase 5,
 * Task 5): the console opening, the auto-refresh timer ticking, a quiet poll
 * answering — and the pane that a one-time token opens, which exists precisely
 * to stop any of those from taking the token off the screen.
 *
 * Its own file rather than more cases in `update.test.ts`: that one is already
 * a thousand lines of the keyboard, and these are the messages that arrive
 * without one. The helpers below are the minimum copied from it.
 */

const SIZE: TerminalSize = { columns: 80, rows: 24 }
const SESSION: Session = { adminName: 'root', role: 'owner' }

/** Rows one PgUp/PgDn moves, as `pageRowsOf` computes it. */
const PAGE_ROWS = SIZE.rows - HEADER_ROWS - FOOTER_ROWS - 2

/** Index of the tabs these cases open; Approvals is the one that polls. */
const HOME_TAB = 0
const APPROVALS_TAB = 8
const JOURNAL_TAB = 9

/** The id of the tab that polls; `polling` names the section a poll was asked for. */
const APPROVALS_ID = 'approvals'

/** What a quiet poll of the Approvals tab asks for. */
const LIST_REQUEST: RunRequest = {
  actionId: 'list',
  argv: ['approvals', 'list'],
  display: ['approvals', 'list'],
}

type MainScreen = Extract<Screen, { kind: 'main' }>
type SigninScreen = Extract<Screen, { kind: 'signin' }>

function key(kind: NamedKey): Msg {
  return { kind: 'key', key: { kind } as KeyEvent }
}

function char(value: string): Msg {
  return { kind: 'key', key: { kind: 'char', char: value } }
}

function mainScreen(patch: Partial<MainScreen> = {}, role: Role = 'owner'): MainScreen {
  const screen = mainScreenOf({ ...SESSION, role }, visibleSections(role))
  if (screen.kind !== 'main') throw new Error('mainScreenOf must build a main screen')

  return { ...screen, ...patch }
}

function mainModel(patch: Partial<MainScreen> = {}, role: Role = 'owner'): Model {
  return { screen: mainScreen(patch, role), size: SIZE }
}

function mainOf(model: Model): MainScreen {
  if (model.screen.kind !== 'main') throw new Error(`expected a main screen, got ${model.screen.kind}`)

  return model.screen
}

function signinOf(model: Model): SigninScreen {
  if (model.screen.kind !== 'signin') throw new Error(`expected a sign-in screen, got ${model.screen.kind}`)

  return model.screen
}

function runResultOf(overrides: Partial<RunResult> = {}): RunResult {
  return {
    argv: ['approvals', 'list'],
    display: ['approvals', 'list'],
    exitCode: 0,
    stdout: 'nothing waiting\n',
    stderr: '',
    ...overrides,
  }
}

function panelOf(overrides: Partial<RunResult> = {}): OutputPanel {
  return outputPanelOf(runResultOf(overrides))
}

/** Numbered lines, so a scroll offset that survived can be told from one that did not. */
function linesOf(count: number): string {
  return `${Array.from({ length: count }, (_, index) => `line ${index}`).join('\n')}\n`
}

/** Stdout of a command that minted a token, long enough to scroll. */
const ONE_TIME_STDOUT = `${linesOf(100)}token: mcpa_x\n${ONE_TIME_TOKEN_MARKER}\n`

const ADMIN_ADD_RESULT: RunResult = {
  argv: ['admin', 'add', 'alice'],
  display: ['admin', 'add', 'alice'],
  exitCode: 0,
  stdout: ONE_TIME_STDOUT,
  stderr: '',
  mintsToken: true,
}

/**
 * The same sentence, printed by a command that mints nothing: `approvals list`
 * prints the arguments an agent chose. Only the ACTION may hold the pane.
 */
const APPROVALS_LIST_RESULT: RunResult = {
  argv: ['approvals', 'list'],
  display: ['approvals', 'list'],
  exitCode: 0,
  stdout: `01K4 tools/call args={"note":"${ONE_TIME_TOKEN_MARKER}"}\n`,
  stderr: '',
}

/** A model showing a one-time token, on the pane that holds it. */
function tokenModel(patch: Partial<MainScreen> = {}): Model {
  const step = update(mainModel(patch), { kind: 'run-result', result: ADMIN_ADD_RESULT })
  return step.model
}

/** A section whose single action leaves the console rather than dispatching. */
const REOPEN_SECTION: SectionSpec = {
  id: 'reopen',
  title: 'Reopen',
  minRole: 'viewer',
  intro: ['leaves the console'],
  actions: [
    {
      id: 'setup',
      title: 'setup',
      minRole: 'viewer',
      command: 'setup',
      leavesConsole: true,
      fields: [],
      argv: () => ['setup'],
      confirm: () => 'Leave the console for the setup screen?',
    },
  ],
}

/**
 * The same section, but naming that action as what `r` and the timer re-run —
 * the one-word catalogue edit the `leavesConsole` rule exists for. Neither key
 * nor tick may dispatch it in-process: the console owns the alternate screen
 * and the action has to be reopened as a child (ADR-0012 §16).
 */
const REOPEN_REFRESH_SECTION: SectionSpec = {
  ...REOPEN_SECTION,
  id: 'reopen-refresh',
  refreshActionId: 'setup',
  autoRefreshMs: 1000,
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

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const each of Object.values(value)) deepFreeze(each)

  return Object.freeze(value)
}

describe('update-live: the console opening', () => {
  test('opened on the sign-in screen asks what the services are doing', () => {
    const model = initialModel(SIZE)

    const step = update(model, { kind: 'opened' })

    expect(step.effects).toEqual([{ kind: 'refresh-services' }])
    expect(step.model).toBe(model)
  })

  test('opened on the main screen asks for nothing: the header was filled at sign-in', () => {
    const model = mainModel()

    const step = update(model, { kind: 'opened' })

    expect(step.effects).toEqual([])
    expect(step.model).toBe(model)
  })
})

describe('update-live: services before anyone has signed in', () => {
  const statuses: readonly ServiceSummary[] = [
    { service: 'ui', state: 'stopped', host: '127.0.0.1', port: 8091 },
  ]

  test('the sign-in screen keeps what status answered', () => {
    const step = update(initialModel(SIZE), { kind: 'services', statuses })

    expect(signinOf(step.model).services).toEqual(statuses)
  })

  test('an unanswerable status takes the line away again', () => {
    const withLine = update(initialModel(SIZE), { kind: 'services', statuses }).model

    const step = update(withLine, { kind: 'services', statuses: undefined })

    expect(signinOf(step.model).services).toBeUndefined()
    expect('services' in signinOf(step.model)).toBe(false)
  })

  test('the notice a lost session left is kept across a services answer', () => {
    const lost = update(mainModel(), { kind: 'session-lost' }).model
    const notice = signinOf(lost).notice

    const step = update(lost, { kind: 'services', statuses })

    expect(signinOf(step.model).notice).toBe(notice)
  })
})

describe('update-live: the tick', () => {
  test('Approvals on its action list polls its own list, quietly', () => {
    const step = update(mainModel({ sectionIndex: APPROVALS_TAB }), { kind: 'tick' })

    expect(step.effects).toEqual([{ kind: 'poll', request: LIST_REQUEST }])
    // The section the poll is FOR, so a late answer under another tab is dropped.
    expect(mainOf(step.model).polling).toBe(APPROVALS_ID)
    expect(mainOf(step.model).busy).toBeUndefined()
  })

  test('a second tick while the poll is out asks nothing', () => {
    const polling = update(mainModel({ sectionIndex: APPROVALS_TAB }), { kind: 'tick' }).model

    const step = update(polling, { kind: 'tick' })

    expect(step.effects).toEqual([])
    expect(step.model).toBe(polling)
  })

  test.each([
    ['a tab that does not re-read itself', mainModel({ sectionIndex: HOME_TAB })],
    ['a run in flight', mainModel({ sectionIndex: APPROVALS_TAB, busy: LIST_REQUEST })],
    ['an open form', mainModel({ sectionIndex: APPROVALS_TAB, pane: { kind: 'help' } })],
    ['the quit question', mainModel({ sectionIndex: APPROVALS_TAB, pane: { kind: 'quit-confirm' } })],
    ['a token nobody has saved', tokenModel({ sectionIndex: APPROVALS_TAB })],
  ])('%s drops the tick', (_name, model) => {
    const step = update(model, { kind: 'tick' })

    expect(step.effects).toEqual([])
    expect(step.model).toBe(model)
  })

  test('the interval the Approvals tab declares is the one phase 5 pinned', () => {
    const section = mainScreen({ sectionIndex: APPROVALS_TAB }).sections[APPROVALS_TAB]

    expect(section?.autoRefreshMs).toBe(APPROVALS_POLL_INTERVAL_MS)
  })
})

describe('update-live: the poll answering', () => {
  function pollingModel(patch: Partial<MainScreen> = {}): Model {
    return mainModel({ sectionIndex: APPROVALS_TAB, polling: APPROVALS_ID, ...patch })
  }

  test('an answer for a tab the operator has left is not drawn on the new one', () => {
    // Tab away while `approvals list` is out: the Journal tab must not suddenly
    // show `$ mcpcut approvals list`.
    const journal = panelOf({
      argv: ['journal', 'list'],
      display: ['journal', 'list'],
      stdout: 'the journal\n',
    })
    const model = mainModel({ sectionIndex: JOURNAL_TAB, polling: APPROVALS_ID, output: journal })

    const step = update(model, { kind: 'poll-result', result: runResultOf() })

    expect(mainOf(step.model).output).toBe(journal)
    // Cleared either way: the poll answered, so the timer may arm again.
    expect(mainOf(step.model).polling).toBeUndefined()
  })

  test('the answer replaces the pane and re-arms the timer', () => {
    const step = update(pollingModel(), { kind: 'poll-result', result: runResultOf() })

    expect(mainOf(step.model).polling).toBeUndefined()
    expect(mainOf(step.model).output?.lines).toEqual(['nothing waiting'])
    expect(step.effects).toEqual([])
  })

  test('where the operator had scrolled to in the same command is kept', () => {
    const previous: OutputPanel = { ...panelOf({ stdout: linesOf(100) }), scroll: 5 }

    const step = update(pollingModel({ output: previous }), {
      kind: 'poll-result',
      result: runResultOf({ stdout: linesOf(100) }),
    })

    expect(mainOf(step.model).output?.scroll).toBe(5)
  })

  test('a scroll past the end of the new text is clamped to it', () => {
    const previous: OutputPanel = { ...panelOf({ stdout: linesOf(100) }), scroll: 90 }

    const step = update(pollingModel({ output: previous }), {
      kind: 'poll-result',
      result: runResultOf({ stdout: linesOf(10) }),
    })

    expect(mainOf(step.model).output?.scroll).toBe(Math.max(0, 10 - PAGE_ROWS))
  })

  test('a failed run of ANOTHER command is left on screen to be read', () => {
    const failed = panelOf({
      argv: ['approvals', 'approve', '01K4'],
      display: ['approvals', 'approve', '01K4'],
      exitCode: 1,
      stdout: '',
      stderr: 'no such request\n',
    })

    const step = update(pollingModel({ output: failed }), {
      kind: 'poll-result',
      result: runResultOf(),
    })

    expect(mainOf(step.model).output).toBe(failed)
    expect(mainOf(step.model).polling).toBeUndefined()
  })

  test('a failed run of the SAME command is replaced: the poll is its rerun', () => {
    const failed = panelOf({ exitCode: 1, stdout: '', stderr: 'queue unreadable\n' })

    const step = update(pollingModel({ output: failed }), {
      kind: 'poll-result',
      result: runResultOf(),
    })

    expect(mainOf(step.model).output?.exitCode).toBe(0)
    expect(mainOf(step.model).output?.lines).toEqual(['nothing waiting'])
  })

  test.each([
    ['a pane opened since', pollingModel({ pane: { kind: 'help' } })],
    ['a run started since', pollingModel({ busy: LIST_REQUEST })],
  ])('a late answer is dropped under %s, and only re-arms the timer', (_name, model) => {
    const before = mainOf(model).output

    const step = update(model, { kind: 'poll-result', result: runResultOf() })

    expect(mainOf(step.model).polling).toBeUndefined()
    expect(mainOf(step.model).output).toBe(before)
    expect(step.effects).toEqual([])
  })
})

describe('update-live: a one-time token on the pane', () => {
  test('a run that minted one opens the hold pane', () => {
    const step = update(mainModel(), { kind: 'run-result', result: ADMIN_ADD_RESULT })

    expect(mainOf(step.model).pane).toEqual({ kind: 'token-hold' })
    expect(mainOf(step.model).output?.holdsOneTimeToken).toBe(true)
    expect(mainOf(step.model).busy).toBeUndefined()
  })

  test('a run of a command that mints nothing does not hold, whatever it printed', () => {
    // The marker is in the output, and an agent put it there.
    const step = update(mainModel({ busy: LIST_REQUEST }), {
      kind: 'run-result',
      result: APPROVALS_LIST_RESULT,
    })

    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
    expect(mainOf(step.model).output?.holdsOneTimeToken).toBe(false)
  })

  test('q leaves at once after such a run: there is no token to lose', () => {
    const shown = update(mainModel({ busy: LIST_REQUEST }), {
      kind: 'run-result',
      result: APPROVALS_LIST_RESULT,
    }).model

    const step = update(shown, char('q'))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
  })

  test('a poll of a command that mints nothing never opens the hold either', () => {
    const polling = mainModel({ sectionIndex: APPROVALS_TAB, polling: APPROVALS_ID })

    const step = update(polling, { kind: 'poll-result', result: APPROVALS_LIST_RESULT })

    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
    expect(mainOf(step.model).output?.holdsOneTimeToken).toBe(false)
  })

  test('a minting run that printed no token returns to the action list', () => {
    const step = update(mainModel({ busy: LIST_REQUEST }), {
      kind: 'run-result',
      result: { ...ADMIN_ADD_RESULT, exitCode: 1, stdout: '', stderr: 'admin exists\n' },
    })

    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
    expect(mainOf(step.model).output?.holdsOneTimeToken).toBe(false)
  })

  test('an ordinary run still returns to the action list', () => {
    const step = update(mainModel({ busy: LIST_REQUEST }), {
      kind: 'run-result',
      result: runResultOf(),
    })

    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
  })

  test.each([
    ['Tab', key('tab')],
    ['Enter', key('enter')],
    ['r', char('r')],
    ['?', char('?')],
    ['a section digit', char('2')],
  ])('%s does nothing while the token is unsaved', (_name, msg) => {
    const model = tokenModel()

    const step = update(model, msg)

    expect(step.effects).toEqual([])
    expect(step.model).toBe(model)
  })

  test('the pane still scrolls: that is how the token is read', () => {
    const step = update(tokenModel(), key('pagedown'))

    expect(mainOf(step.model).output?.scroll).toBe(PAGE_ROWS)
    expect(mainOf(step.model).pane).toEqual({ kind: 'token-hold' })
  })

  test('y records that it was saved and gives the keyboard back', () => {
    const step = update(tokenModel(), char('y'))

    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
    expect(mainOf(step.model).output?.tokenAcknowledged).toBe(true)
    expect(step.effects).toEqual([])
  })

  test('q asks before it takes the screen away', () => {
    const step = update(tokenModel(), char('q'))

    expect(mainOf(step.model).pane).toEqual({ kind: 'quit-confirm' })
    expect(step.effects).toEqual([])
  })

  test('any other answer to that question returns to the hold, not the list', () => {
    const asked = update(tokenModel(), char('q')).model

    const step = update(asked, char('n'))

    expect(mainOf(step.model).pane).toEqual({ kind: 'token-hold' })
    expect(step.effects).toEqual([])
  })

  test('once saved, q leaves without asking', () => {
    const saved = update(tokenModel(), char('y')).model

    const step = update(saved, char('q'))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
  })

  test('the token pane survives a resize, which is not a keystroke', () => {
    const step = update(tokenModel(), { kind: 'resize', size: { columns: 40, rows: 10 } })

    expect(mainOf(step.model).pane).toEqual({ kind: 'token-hold' })
    expect(step.model.size).toEqual({ columns: 40, rows: 10 })
  })
})

describe('update-live: an action that leaves the console', () => {
  const reopenModel = mainModel({ sections: [REOPEN_SECTION] })

  test('Enter asks the question first', () => {
    const step = update(reopenModel, key('enter'))

    expect(mainOf(step.model).pane.kind).toBe('confirm')
    expect(step.effects).toEqual([])
  })

  test('y hands the terminal over instead of dispatching', () => {
    const asked = update(reopenModel, key('enter')).model

    const step = update(asked, char('y'))

    expect(step.effects).toEqual([{ kind: 'reopen', argv: ['setup'] }])
    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
    // No `busy`: nothing is running here, the console is going away.
    expect(mainOf(step.model).busy).toBeUndefined()
  })

  test('anything else cancels, as any other confirmation does', () => {
    const asked = update(reopenModel, key('enter')).model

    const step = update(asked, char('n'))

    expect(step.effects).toEqual([])
    expect(mainOf(step.model).pane).toEqual({ kind: 'actions' })
  })
})

describe('update-live: a refresh that would leave the console', () => {
  const model = mainModel({ sections: [REOPEN_REFRESH_SECTION] })

  test('the timer tick runs nothing: a poll cannot hand the terminal over', () => {
    const step = update(model, { kind: 'tick' })

    expect(step.effects).toEqual([])
    expect(step.model).toBe(model)
  })

  test('r refreshes only the header: the section has no action it may re-run', () => {
    const step = update(model, char('r'))

    expect(step.effects).toEqual([{ kind: 'refresh-services' }])
  })
})

describe('update-live: what the console makes of a config load', () => {
  const CONFIG_PATH = '/home/op/.mcpcut/config.json'

  test('a config that names an external supervisor is taken at its word', () => {
    const config = { ...defaultInstallConfig('/var/lib/x'), supervisor: EXTERNAL_SUPERVISOR }

    expect(installFactsOf({ kind: 'ok', path: CONFIG_PATH, config })).toEqual({
      supervisor: EXTERNAL_SUPERVISOR,
    })
  })

  test('an absent config — the only other kind a console opens with — supervises itself', () => {
    // `invalid` cannot arrive: every command, `runTui` included, refuses on
    // `describeDataDirProblem` before a frame exists (ADR-0012 §5, and
    // `tests/cli/tui-cmd.test.ts` "refuses an unusable config"). So this
    // default is the truth about an install that never ran `setup`, not a
    // guess over a file that could not be read.
    expect(installFactsOf({ kind: 'absent', path: CONFIG_PATH })).toEqual(DEFAULT_INSTALL_FACTS)
    expect(DEFAULT_INSTALL_FACTS.supervisor).not.toBe(EXTERNAL_SUPERVISOR)
  })
})

describe('update-live: what the install hides', () => {
  test('an externally supervised install is offered no start or stop', () => {
    const model: Model = { ...initialModel(SIZE), install: { supervisor: EXTERNAL_SUPERVISOR } }

    const step = update(model, {
      kind: 'signin-result',
      result: { kind: 'ok', name: 'root', role: 'owner' },
    })

    const services = mainOf(step.model).sections.find((section) => section.id === 'services')
    expect(services?.actions.map((action) => action.id)).toEqual(['status', 'logs', 'setup'])
  })

  test('an install mcpcut supervises keeps all five', () => {
    const step = update(initialModel(SIZE), {
      kind: 'signin-result',
      result: { kind: 'ok', name: 'root', role: 'owner' },
    })

    const services = mainOf(step.model).sections.find((section) => section.id === 'services')
    expect(services?.actions.map((action) => action.id)).toEqual([
      'status',
      'start',
      'stop',
      'logs',
      'setup',
    ])
  })

  test('a lost session asks the services again, so the screen it lands on has its banner', () => {
    // The sign-in screen draws `services: …`, and the answer it had belonged
    // to the session that has just gone. Without this the operator is dropped
    // onto a screen that has forgotten whether the daemons are up (F14).
    const step = update(mainModel(), { kind: 'session-lost' })

    expect(step.effects).toEqual([{ kind: 'refresh-services' }])
    expect(signinOf(step.model).services).toBeUndefined()
  })

  test('a lost session carries the install back to the sign-in screen', () => {
    const model: Model = {
      ...mainModel(),
      install: { supervisor: EXTERNAL_SUPERVISOR },
    }

    const step = update(model, { kind: 'session-lost' })

    expect(step.model.install).toEqual({ supervisor: EXTERNAL_SUPERVISOR })
  })
})

describe('update-live: nothing mutates what it was handed', () => {
  const cases: ReadonlyArray<readonly [string, Model, Msg]> = [
    ['sign-in: opened', initialModel(SIZE), { kind: 'opened' }],
    ['sign-in: services', initialModel(SIZE), { kind: 'services', statuses: [] }],
    ['main: opened', mainModel(), { kind: 'opened' }],
    ['main: tick', mainModel({ sectionIndex: APPROVALS_TAB }), { kind: 'tick' }],
    [
      'main: poll answered',
      mainModel({ sectionIndex: APPROVALS_TAB, polling: APPROVALS_ID }),
      { kind: 'poll-result', result: runResultOf() },
    ],
    [
      'main: a minted token',
      mainModel(),
      { kind: 'run-result', result: ADMIN_ADD_RESULT },
    ],
    ['main: token saved', tokenModel(), char('y')],
  ]

  test.each(cases)('%s', (_name, model, msg) => {
    const before = snapshotOf(model)
    deepFreeze(model)

    update(model, msg)

    expect(model).toEqual(before)
  })
})
