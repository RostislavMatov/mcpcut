import { OWN_SUPERVISOR } from '../../src/tui/model.js'
import { describe, expect, test } from 'vitest'
import { visibleSections } from '../../src/tui/catalogue/index.js'
import type { SectionSpec } from '../../src/tui/catalogue/types.js'
import { PENDING_KEYS_MAX } from '../../src/tui/constants-live.js'
import { EXIT_OK, ONE_TIME_TOKEN_MARKER } from '../../src/tui/constants.js'
import type { KeyEvent, NamedKey } from '../../src/tui/keys.js'
import {
  mainScreenOf,
  type MainScreen,
  type Model,
  type Msg,
  type RunRequest,
  type Session,
  type Step,
  type TerminalSize,
} from '../../src/tui/model.js'
import type { RunResult } from '../../src/tui/output.js'
import { update } from '../../src/tui/update.js'
import { appendPending, replayPending } from '../../src/tui/update-keys.js'

/**
 * The keys pressed while a run is in flight (mcpcut phase 6, F5 / Q30). Before
 * this phase the keyboard was deaf during a run; now it is DEFERRED: each key
 * is queued on the screen, and the queue is replayed through the ordinary key
 * reducer once `run-result` arrives — unless that result holds a one-time
 * token, in which case the queue is thrown away, because nothing typed blind
 * may count as "I saved the token" (plan P2 is older than Q30).
 *
 * Every case goes through `update`, so the routing in `update.ts`, the
 * replay in `update-main.ts` and the fold in `update-keys.ts` are asserted as
 * one behaviour; the two edge guards of `replayPending` that `update` cannot
 * reach are called directly at the end.
 */

const SIZE: TerminalSize = { columns: 80, rows: 24 }
const SESSION: Session = { adminName: 'root', role: 'owner' }

/** Owner tabs, in tab-bar order: `9` names Approvals, Tab from there is Journal. */
const HOME_TAB = 0
/** Home ▸ disconnect — the second Home action, offered only to a remote console. */
const DISCONNECT_ACTION = 1
const ADMINS_TAB = 1
const APPROVALS_TAB = 8
const JOURNAL_TAB = 9

/** Position of `admin add` under the Admins tab: the first action with a form. */
const ADMIN_ADD_ACTION = 1

const LIST_REQUEST: RunRequest = {
  actionId: 'list',
  argv: ['admin', 'list'],
  display: ['admin', 'list'],
}

/** Stdout of a command that minted a token, as `outputPanelOf` recognises it. */
const ONE_TIME_STDOUT = `token: mcpa_x\n${ONE_TIME_TOKEN_MARKER}\n`

function key(kind: NamedKey): Msg {
  return { kind: 'key', key: { kind } as KeyEvent }
}

function char(value: string): Msg {
  return { kind: 'key', key: { kind: 'char', char: value } }
}

function ctrl(value: string): Msg {
  return { kind: 'key', key: { kind: 'ctrl', char: value } }
}

/** The key inside a key message, for building `pendingKeys` by hand. */
function keyOf(msg: Msg): KeyEvent {
  if (msg.kind !== 'key') throw new Error('expected a key message')

  return msg.key
}

function mainScreen(patch: Partial<MainScreen> = {}): MainScreen {
  const screen = mainScreenOf(SESSION, visibleSections('owner'))
  if (screen.kind !== 'main') throw new Error('mainScreenOf must build a main screen')

  return { ...screen, ...patch }
}

/** A frozen model: any write into what the reducer was handed is a `TypeError`. */
function mainModel(patch: Partial<MainScreen> = {}): Model {
  return deepFreeze({ screen: mainScreen(patch), size: SIZE })
}

function mainOf(model: Model): MainScreen {
  if (model.screen.kind !== 'main') throw new Error(`expected a main screen, got ${model.screen.kind}`)

  return model.screen
}

function runResultOf(overrides: Partial<RunResult> = {}): RunResult {
  return {
    argv: ['admin', 'list'],
    display: ['admin', 'list'],
    exitCode: 0,
    stdout: 'root  owner\n',
    stderr: '',
    ...overrides,
  }
}

const RUN_RESULT: Msg = { kind: 'run-result', result: runResultOf() }

/** A run in flight with these keys already queued behind it. */
function busyWith(pending: readonly Msg[], patch: Partial<MainScreen> = {}): Model {
  return mainModel({ busy: LIST_REQUEST, pendingKeys: pending.map(keyOf), ...patch })
}

/** A section with no refresh action: `r` there asks only for the header. */
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

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const each of Object.values(value)) deepFreeze(each)

  return Object.freeze(value)
}

describe('appendPending', () => {
  test('a key lands at the end of an empty buffer', () => {
    expect(appendPending(undefined, keyOf(char('a')))).toEqual([keyOf(char('a'))])
  })

  test('a full buffer keeps its FIRST keys and drops the new one', () => {
    const full = deepFreeze(
      Array.from({ length: PENDING_KEYS_MAX }, (_, index) => keyOf(char(String(index)))),
    )

    const appended = appendPending(full, keyOf(char('late')))

    expect(appended).toHaveLength(PENDING_KEYS_MAX)
    expect(appended).toEqual(full)
  })

  test('the buffer handed in is never written to', () => {
    const pending = deepFreeze([keyOf(char('a'))])

    const appended = appendPending(pending, keyOf(char('b')))

    expect(appended).not.toBe(pending)
    expect(pending).toEqual([keyOf(char('a'))])
    expect(appended).toEqual([keyOf(char('a')), keyOf(char('b'))])
  })
})

describe('update: keys while a run is in flight are queued, not dropped', () => {
  test('every key but Ctrl-C is queued on the screen with no effect', () => {
    const model = mainModel({ busy: LIST_REQUEST })

    for (const msg of [key('enter'), char('q'), char('2'), key('down'), char('r')]) {
      const step = update(model, msg)

      expect(step.model).not.toBe(model)
      expect(step.effects).toEqual([])
      expect(mainOf(step.model).pendingKeys).toEqual([keyOf(msg)])
      expect(mainOf(step.model).busy).toEqual(LIST_REQUEST)
    }
  })

  test('the 33rd key is dropped: the buffer keeps the first 32', () => {
    const keys = Array.from({ length: PENDING_KEYS_MAX + 1 }, (_, index) =>
      char(String(index)),
    )

    const queued = keys.reduce(
      (current, msg) => deepFreeze(update(current, msg).model),
      mainModel({ busy: LIST_REQUEST }),
    )

    expect(mainOf(queued).pendingKeys).toEqual(keys.slice(0, PENDING_KEYS_MAX).map(keyOf))
  })

  test('Ctrl-C with keys queued quits at once and replays none of them', () => {
    const model = busyWith([char('9'), key('enter')])

    const step = update(model, ctrl('c'))

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
    expect(mainOf(step.model).sectionIndex).toBe(HOME_TAB)
  })

  test('a tick during the run leaves the queue as it is', () => {
    const model = busyWith([char('9')])

    const step = update(model, { kind: 'tick' })

    expect(step.model).toBe(model)
    expect(step.effects).toEqual([])
  })

  test('session-lost drops the queue with the screen: nothing is replayed', () => {
    const model = busyWith([char('q'), key('enter')])

    const step = update(model, { kind: 'session-lost' })

    expect(step.model.screen.kind).toBe('signin')
    expect('pendingKeys' in step.model.screen).toBe(false)
    expect(step.effects).toEqual([{ kind: 'refresh-services' }])
  })
})

describe('update: the queue is replayed when the run answers', () => {
  test('`9` then Tab: the ninth tab is selected and the Tab moves on from it', () => {
    const model = busyWith([char('9'), key('tab')])

    const step = update(model, RUN_RESULT)

    const screen = mainOf(step.model)
    expect(screen.sectionIndex).toBe(JOURNAL_TAB)
    expect(screen.busy).toBeUndefined()
    expect('pendingKeys' in screen).toBe(false)
    // The run's panel landed and was then left behind by the replayed Tab:
    // since UX-10 a section switch clears the pane, and a queued Tab is the
    // operator saying "take me elsewhere" as much as a live one is.
    expect(screen.output).toBeUndefined()
    expect(step.effects).toEqual([])
  })

  test('the effects of every replayed key come out in the order the keys went in', () => {
    // `r` on a tab with no refresh action asks for the header only, and the
    // fold goes on to the Tab after it; nothing here sets `busy`.
    const model = busyWith([char('r'), key('tab')], {
      sections: [PLAIN_SECTION, ...visibleSections('owner')],
      sectionIndex: 0,
    })

    const step = update(model, RUN_RESULT)

    expect(step.effects).toEqual([{ kind: 'refresh-services' }])
    expect(mainOf(step.model).sectionIndex).toBe(1)
    expect(mainOf(step.model).busy).toBeUndefined()
  })

  test('a replayed key that starts a run re-queues the keys behind it', () => {
    // Tab to Admins, `r` reruns `admin list` — one `run`, `busy` set — and the
    // `9` behind it waits for THAT run's answer, exactly as a typed one would.
    const model = busyWith([key('tab'), char('r'), char('9')])

    const step = update(model, RUN_RESULT)

    const screen = mainOf(step.model)
    expect(screen.sectionIndex).toBe(ADMINS_TAB)
    expect(screen.busy).toEqual(LIST_REQUEST)
    expect(screen.pendingKeys).toEqual([keyOf(char('9'))])
    expect(step.effects.filter((effect) => effect.kind === 'run')).toHaveLength(1)
    expect(step.effects).toEqual([
      { kind: 'run', request: LIST_REQUEST },
      { kind: 'refresh-services' },
    ])
  })

  test('32 queued Enters on a form-less action give ONE run; the rest wait for it', () => {
    const enters = Array.from({ length: PENDING_KEYS_MAX }, () => key('enter'))
    const model = busyWith(enters, { sectionIndex: ADMINS_TAB })

    const step = update(model, RUN_RESULT)

    expect(step.effects.filter((effect) => effect.kind === 'run')).toHaveLength(1)
    expect(mainOf(step.model).pendingKeys).toHaveLength(PENDING_KEYS_MAX - 1)
  })

  test('Enter, Enter on an action with a form: the second Enter is fed to the form', () => {
    // The first Enter opens `admin add`; the second submits the untouched
    // form, whose name is required — so the form stays open, showing why.
    // A queued Enter can run a form, just never past its own validation.
    const model = busyWith([key('enter'), key('enter')], {
      sectionIndex: ADMINS_TAB,
      actionIndex: ADMIN_ADD_ACTION,
    })

    const step = update(model, RUN_RESULT)

    const { pane } = mainOf(step.model)
    expect(pane.kind).toBe('form')
    if (pane.kind !== 'form') throw new Error('expected the form pane')
    expect(pane.actionId).toBe('add')
    expect(pane.form.fields[0]?.error).toBe('required')
    expect(step.effects).toEqual([])
  })

  test('Enter, a name, Enter on an action with a form: the form runs once it is valid', () => {
    const model = busyWith([key('enter'), char('b'), key('enter')], {
      sectionIndex: ADMINS_TAB,
      actionIndex: ADMIN_ADD_ACTION,
    })

    const step = update(model, RUN_RESULT)

    const screen = mainOf(step.model)
    expect(screen.pane).toEqual({ kind: 'actions' })
    expect(screen.busy?.argv.slice(0, 3)).toEqual(['admin', 'add', 'b'])
    expect(step.effects.filter((effect) => effect.kind === 'run')).toHaveLength(1)
  })

  test('a replayed `q` quits, and the keys behind it are not fed to a screen that is leaving', () => {
    const model = busyWith([char('q'), char('9')])

    const step = update(model, RUN_RESULT)

    expect(step.effects).toEqual([{ kind: 'quit', exitCode: EXIT_OK }])
    expect(mainOf(step.model).sectionIndex).toBe(HOME_TAB)
  })

  test('a replayed `disconnect` leaves, and the keys behind it are not fed to a screen that is leaving', () => {
    // Review of 2026-09-20: `disconnect` ends the console exactly as `quit`
    // and `reopen` do, so the queue must stop at it — otherwise the last frame
    // drawn before the connect form is some tab the operator never opened.
    const facts = { supervisor: OWN_SUPERVISOR, remote: true, remoteAddress: 'http://127.0.0.1:8091' }
    const remote: Model = {
      ...busyWith([key('enter'), char('9')], {
        actionIndex: DISCONNECT_ACTION,
        // The screen carries its own filtered sections: a remote console's include `disconnect`.
        sections: visibleSections('owner', undefined, facts),
      }),
      install: facts,
    }

    const step = update(remote, RUN_RESULT)

    expect(step.effects.map((effect) => effect.kind)).toEqual(['disconnect'])
    expect(mainOf(step.model).sectionIndex).toBe(HOME_TAB)
  })

  test('a result that holds a one-time token throws the queue away', () => {
    // `y` typed blind must not count as "saved": the hold pane opens with the
    // token unacknowledged and nothing queued behind it.
    const model = busyWith([char('y'), char('9')])
    const result = runResultOf({
      argv: ['admin', 'add', 'alice'],
      display: ['admin', 'add', 'alice'],
      stdout: ONE_TIME_STDOUT,
      mintsToken: true,
    })

    const step = update(model, { kind: 'run-result', result })

    const screen = mainOf(step.model)
    expect(screen.pane).toEqual({ kind: 'token-hold' })
    expect('pendingKeys' in screen).toBe(false)
    expect(screen.output?.tokenAcknowledged).toBe(false)
    expect(screen.sectionIndex).toBe(HOME_TAB)
    expect(step.effects).toEqual([])
  })

  test('a result with nothing queued behind it replays nothing', () => {
    const model = mainModel({ busy: LIST_REQUEST, sectionIndex: APPROVALS_TAB })

    const step = update(model, RUN_RESULT)

    expect(mainOf(step.model).sectionIndex).toBe(APPROVALS_TAB)
    expect('pendingKeys' in mainOf(step.model)).toBe(false)
    expect(step.effects).toEqual([])
  })
})

describe('replayPending: the guards `update` cannot reach', () => {
  const never = (): Step => {
    throw new Error('apply must not be called')
  }

  test('an empty queue returns the step it was handed', () => {
    const step: Step = deepFreeze({ model: mainModel(), effects: [] })

    expect(replayPending(step, [], never)).toBe(step)
  })

  test('a screen holding a token returns the step it was handed', () => {
    const step: Step = deepFreeze({ model: mainModel({ pane: { kind: 'token-hold' } }), effects: [] })

    expect(replayPending(step, [keyOf(char('y'))], never)).toBe(step)
  })

  test('a screen that is not the main one returns the step it was handed', () => {
    const model: Model = deepFreeze({
      screen: { kind: 'signin', form: { fields: [], focus: 0 }, busy: false },
      size: SIZE,
    })
    const step: Step = deepFreeze({ model, effects: [] })

    expect(replayPending(step, [keyOf(char('9'))], never)).toBe(step)
  })
})
