import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import type { DispatchFn } from '../../src/cli/dispatch-types.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import { plainStyle } from '../../src/tui/ansi.js'
import type { SectionSpec } from '../../src/tui/catalogue/types.js'
import {
  ACTIVE_MARKER,
  EXIT_INTERRUPTED,
  EXIT_OK,
  SECRET_MASK_CHAR,
  SIGNIN_TITLE,
} from '../../src/tui/constants.js'
import type { Model, Msg, Session, TerminalSize } from '../../src/tui/model.js'
import {
  createReopenCell,
  createTokenCell,
  createWizardOutcomeCell,
  type TokenCell,
} from '../../src/tui/runtime-effects.js'
import { createLoop } from '../../src/tui/runtime.js'
import { wizardScreenOf, type WizardPrefill } from '../../src/tui/wizard-fields.js'
import { createFakeTerminal, waitForScreen } from './support/fake-terminal.js'
import {
  ADMIN_NAME,
  ADMIN_ROLE,
  CONSOLE_ENV,
  captureStderr,
  closeRuntimeStand,
  createTestAdmin,
  depsOf,
  openRuntimeStand,
  quietDispatch,
  signedInConsole,
  startConsole,
  waitForUntilTrue,
} from './support/runtime-harness.js'

/**
 * The console's runtime (mcpcut phase 2, task 13): the only effectful module
 * of the console, and therefore the only one whose tests are about a terminal
 * rather than about a value.
 *
 * This file holds the loop: the effect queue, keys decoded from bytes, effects
 * folded back in, the subscription timer and the effects nobody typed (phase
 * 5), and an action that leaves the console. The three properties the module
 * exists for — the terminal RESTORED on every exit path, nothing left on the
 * process, a promise that always RESOLVES — are pinned in
 * `runtime-lifecycle.test.ts` (split in phase 6, task 9). The stand both
 * share, a console over a `PassThrough` and a temp admin store, is
 * `support/runtime-harness.ts`.
 *
 * The tests drive real bytes through a `PassThrough` (`support/fake-terminal.
 * ts`) so `readline.emitKeypressEvents` does the decoding it will do in
 * production — a chunk carrying two keys, an escape sequence split across two
 * chunks and a lone `Esc` that only resolves on a timeout are all things the
 * decoder, not the console, gets right or wrong.
 */

/** An action of the Admins section, and one of Home: what a frame is read for. */
const ADMINS_ACTION = 'rotate'
const ADMINS_SECTION_KEY = '2'

beforeEach(openRuntimeStand)
afterEach(closeRuntimeStand)

// ---------------------------------------------------------------------------
// The effect queue
// ---------------------------------------------------------------------------

describe('the queue: what a settled console still owes the wizard', () => {
  /** An install whose services belong to Compose, so `setup` alone finishes the wizard. */
  function externalPrefill(): WizardPrefill {
    const config = defaultInstallConfig('/var/lib/x')

    return {
      mode: 'first-run',
      configPath: '/home/alice/.mcpcut/config.json',
      config: { ...config, supervisor: 'external' },
    }
  }

  /** A dispatcher that takes the command and never answers. */
  const neverAnswers: DispatchFn = () => new Promise<number>(() => undefined)

  const SETUP_STDOUT = 'admin: owner\nrole: owner\ntoken: mcpa_x\n'

  const ENTER: Msg = { kind: 'key', key: { kind: 'enter' } }
  const YES: Msg = { kind: 'key', key: { kind: 'char', char: 'y' } }
  const SETUP_DONE: Msg = {
    kind: 'wizard-run-result',
    step: 'setup',
    result: {
      argv: ['setup', '--yes'],
      display: ['setup', '--yes'],
      exitCode: EXIT_OK,
      stdout: SETUP_STDOUT,
      stderr: '',
    },
  }

  test('the wizard answer is left in the cell with a run still in flight', () => {
    // The queue is made busy on purpose: `setup` is dispatched and never
    // answers, so every later link of the chain is stuck behind it. The
    // wizard reaches its final screen anyway — the result is folded in from
    // outside — and the answer it hands back must not wait on the queue,
    // because the drain that follows a quit is bounded.
    const outcome = createWizardOutcomeCell()
    const fake = createFakeTerminal()
    const base = depsOf(fake.terminal, new EventEmitter(), captureStderr(), neverAnswers)
    const loop = createLoop({
      ...base,
      effects: { ...base.effects, wizard: { outcome } },
      initial: (size) => ({ screen: wizardScreenOf(externalPrefill()), size }),
    })

    loop.step(ENTER)
    loop.step(SETUP_DONE)
    loop.step(YES)

    expect(outcome.get()).toBe('sign-in')
    expect(loop.exitCode()).toBe(EXIT_OK)
  })

  test('the run that never answered is still the one the queue is stuck on', async () => {
    // Guards the guard: without a busy queue the test above would pass on a
    // `wizard-finish` that only runs when the chain drains.
    const dispatched: string[][] = []
    const fake = createFakeTerminal()
    const base = depsOf(fake.terminal, new EventEmitter(), captureStderr(), (argv) => {
      dispatched.push([...argv])
      return new Promise<number>(() => undefined)
    })
    const loop = createLoop({
      ...base,
      effects: { ...base.effects, wizard: { outcome: createWizardOutcomeCell() } },
      initial: (size) => ({ screen: wizardScreenOf(externalPrefill()), size }),
    })

    loop.step(ENTER)
    // The queue hands an effect to the dispatcher a microtask later.
    await new Promise((resolve) => setImmediate(resolve))

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.[0]).toBe('setup')
  })
})

// ---------------------------------------------------------------------------
// Keys, as bytes
// ---------------------------------------------------------------------------

describe('runConsole: decoding what arrives', () => {
  test('two keys in one chunk are both folded in', async () => {
    const { harness } = await signedInConsole()
    harness.fake.type(ADMINS_SECTION_KEY)
    await waitForScreen(
      harness.fake,
      (screen) => screen.includes(ADMINS_ACTION),
      'the actions of the Admins section',
    )

    harness.fake.type('jj')

    await waitForScreen(
      harness.fake,
      (screen) => screen.includes(`${ACTIVE_MARKER}${ADMINS_ACTION}`),
      'the cursor two actions down',
    )
  })

  test('an escape sequence split across two chunks decodes as one arrow key', async () => {
    const { harness } = await signedInConsole()
    expect(harness.fake.screen()).not.toContain(ADMINS_ACTION)

    harness.fake.type('\x1b[')
    harness.fake.type('C')

    await waitForScreen(
      harness.fake,
      (screen) => screen.includes(ADMINS_ACTION),
      'the next section, reached by a right arrow',
    )
  })

  test('what is typed into the token field never reaches the frame unmasked', async () => {
    const harness = startConsole()
    await waitForScreen(harness.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    harness.fake.type('ab')

    await waitForScreen(
      harness.fake,
      (screen) => screen.includes(SECRET_MASK_CHAR.repeat(2)),
      'both typed characters, masked',
    )
    expect(harness.fake.screen()).not.toContain('ab')
  })

  test('a resize redraws at the size the terminal now reports', async () => {
    const harness = startConsole()
    await waitForScreen(harness.fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')

    harness.fake.resize(40, 10)

    await waitForScreen(
      harness.fake,
      (screen) => screen.split('\n').length === 10,
      'a frame at the new size',
    )
    expect(harness.fake.screen().split('\n').every((line) => line.length <= 40)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

describe('runConsole: effects', () => {
  test('a command that throws becomes a failed run, and the console stays up', async () => {
    const failing: DispatchFn = async () => {
      throw new Error('the dispatcher blew up')
    }
    const { harness } = await signedInConsole({ dispatch: failing })

    harness.fake.type('\r')

    await waitForScreen(
      harness.fake,
      (screen) => screen.includes('exit 1'),
      'a failed run in the output pane',
    )
    harness.fake.type('q')
    await expect(harness.exit).resolves.toBe(EXIT_OK)
    expect(harness.fake.restored()).toBe(true)
  })

  test('a signal while a command is in flight still leaves with the terminal restored', async () => {
    const slow: DispatchFn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return EXIT_OK
    }
    const { harness } = await signedInConsole({ dispatch: slow })

    harness.fake.type('\r')
    harness.processEvents.emit('SIGTERM')

    await expect(harness.exit).resolves.toBe(EXIT_INTERRUPTED)
    expect(harness.fake.restored()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The subscription timer, `opened` and the effects nobody typed (phase 5)
// ---------------------------------------------------------------------------

/** How often the synthetic polled section re-reads itself. */
const POLL_INTERVAL_MS = 20

/** Longer than a keystroke takes to reach a frame, so "before the answer" is observable. */
const SLOW_POLL_MS = 300

/** What a quiet poll prints, so a frame can be asked whether its answer landed. */
const POLL_OUTPUT_MARK = 'queue-answered-here'

/**
 * How long an absence is watched for. Every OTHER wait in this file is a
 * predicate over the frame; these are the two assertions about something that
 * must NOT happen, and a window is the only shape they have.
 */
const ABSENCE_WINDOW_MS = 60

/** A tab that re-reads itself, standing in for Approvals without pinning its interval. */
const POLLED_SECTION: SectionSpec = {
  id: 'polled',
  title: 'Polled',
  minRole: 'viewer',
  intro: ['a tab that re-reads itself'],
  refreshActionId: 'list',
  autoRefreshMs: POLL_INTERVAL_MS,
  actions: [
    {
      id: 'list',
      title: 'list',
      minRole: 'viewer',
      command: 'approvals',
      subcommand: 'list',
      fields: [],
      argv: () => ['approvals', 'list'],
    },
  ],
}

/**
 * The action title the plain tab is recognised by. Its intro will not do: a
 * poll that has already answered leaves an output panel where the intro was,
 * and the panel outlives the tab switch.
 */
const PLAIN_ACTION_TITLE = 'noop'

/** The other half of the rule: a tab with nothing to poll takes the timer down. */
const PLAIN_SECTION: SectionSpec = {
  id: 'plain',
  title: 'Plain',
  minRole: 'viewer',
  intro: ['nothing to refresh here'],
  actions: [
    {
      id: 'noop',
      title: PLAIN_ACTION_TITLE,
      minRole: 'viewer',
      command: 'status',
      fields: [],
      argv: () => ['status'],
    },
  ],
}

/** An action that hands the terminal to a child instead of dispatching (`setup`). */
const REOPEN_SECTION: SectionSpec = {
  id: 'reopening',
  title: 'Reopening',
  minRole: 'viewer',
  intro: ['an action that leaves the console'],
  actions: [
    {
      id: 'setup',
      title: 'setup',
      minRole: 'viewer',
      command: 'setup',
      fields: [],
      argv: () => ['setup'],
      leavesConsole: true,
    },
  ],
}

const TEST_SESSION: Session = { adminName: ADMIN_NAME, role: ADMIN_ROLE }

/** A main screen over synthetic sections: these tests are about the runtime, not the catalogue. */
function mainModelOf(sections: readonly SectionSpec[], size: TerminalSize): Model {
  return {
    screen: {
      kind: 'main',
      session: TEST_SESSION,
      sections,
      sectionIndex: 0,
      actionIndex: 0,
      pane: { kind: 'actions' },
    },
    size,
  }
}

/** A cell holding a session the store really resolves, for a console that opens signed in. */
async function sessionCell(): Promise<TokenCell> {
  const cell = createTokenCell()
  cell.set(await createTestAdmin())
  return cell
}

interface CountingDispatch {
  readonly fn: DispatchFn
  /** Live, so a test can watch it. */
  readonly calls: readonly (readonly string[])[]
  countOf(command: string): number
}

/** A `dispatch` that counts what it was asked to run, and answers as told. */
function countingDispatch(answer: () => Promise<number> = async () => EXIT_OK): CountingDispatch {
  const calls: string[][] = []
  return {
    calls,
    countOf: (command: string) => calls.filter((argv) => argv[0] === command).length,
    fn: async (argv) => {
      calls.push([...argv])
      return answer()
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('runConsole: what opening the console asks for', () => {
  test('the sign-in screen asks for the service line before anybody has typed', async () => {
    const dispatch = countingDispatch()
    const harness = startConsole({ dispatch: dispatch.fn })

    await waitForUntilTrue(() => dispatch.calls.length > 0)

    expect(dispatch.calls[0]).toEqual(['status', '--json'])
    harness.fake.type('\x03')
    await expect(harness.exit).resolves.toBe(EXIT_OK)
  })

  test("the status it asks for carries the console's own environment, and no session", async () => {
    const seen: (NodeJS.ProcessEnv | undefined)[] = []
    const harness = startConsole({
      dispatch: async (_argv, _io, opts) => {
        seen.push(opts?.services?.env)
        return EXIT_OK
      },
    })

    await waitForUntilTrue(() => seen.length > 0)

    expect(seen[0]).toEqual(CONSOLE_ENV)
    expect(seen[0]?.[ADMIN_TOKEN_ENV_VAR]).toBeUndefined()
    harness.fake.type('\x03')
    await expect(harness.exit).resolves.toBe(EXIT_OK)
  })
})

describe('runConsole: the subscription timer', () => {
  test('a subscribed tab polls on its own, and stops when the tab is left', async () => {
    const dispatch = countingDispatch()
    const harness = startConsole({
      dispatch: dispatch.fn,
      token: await sessionCell(),
      initial: (size) => mainModelOf([POLLED_SECTION, PLAIN_SECTION], size),
    })

    await waitForUntilTrue(() => dispatch.countOf('approvals') >= 2)
    harness.fake.type('\t')
    await waitForScreen(
      harness.fake,
      (screen) => screen.includes(PLAIN_ACTION_TITLE),
      'the plain tab, which subscribes to nothing',
    )

    // ABSENCE assertion: a window is the only way to watch for polls that must
    // never be asked for. Three times the interval the tab used to poll at.
    const settled = dispatch.countOf('approvals')
    await sleep(ABSENCE_WINDOW_MS)
    expect(dispatch.countOf('approvals')).toBe(settled)
    harness.fake.type('q')
    await expect(harness.exit).resolves.toBe(EXIT_OK)
  })

  test('q takes the timer with it: nothing is dispatched once the console has left', async () => {
    const dispatch = countingDispatch()
    const harness = startConsole({
      dispatch: dispatch.fn,
      token: await sessionCell(),
      initial: (size) => mainModelOf([POLLED_SECTION, PLAIN_SECTION], size),
    })
    await waitForUntilTrue(() => dispatch.countOf('approvals') >= 1)

    harness.fake.type('q')
    await expect(harness.exit).resolves.toBe(EXIT_OK)

    // ABSENCE assertion: the timer is unref'd, so a leak would not hang the
    // worker — it would poll a settled console instead.
    const atExit = dispatch.countOf('approvals')
    await sleep(ABSENCE_WINDOW_MS)
    expect(dispatch.countOf('approvals')).toBe(atExit)
    expect(harness.fake.restored()).toBe(true)
  })

  test('a poll in flight never makes the keyboard deaf, and its answer stays on its own tab', async () => {
    let answered = 0
    const calls: string[][] = []
    const dispatch: DispatchFn = async (argv, io) => {
      calls.push([...argv])
      await sleep(SLOW_POLL_MS)
      io.stdout.write(`${POLL_OUTPUT_MARK}\n`)
      answered += 1
      return EXIT_OK
    }
    const harness = startConsole({
      dispatch,
      token: await sessionCell(),
      initial: (size) => mainModelOf([POLLED_SECTION, PLAIN_SECTION], size),
    })
    await waitForUntilTrue(() => calls.some((argv) => argv[0] === 'approvals'))

    harness.fake.type('\t')

    await waitForScreen(
      harness.fake,
      (screen) => screen.includes(PLAIN_ACTION_TITLE),
      'the next tab, reached while the poll is still out',
    )
    expect(answered).toBe(0)

    // The answer now arrives on a tab that never asked for it. Nobody may see
    // another tab's command line and text appear under this one (F2).
    await waitForUntilTrue(() => answered >= 1)
    await sleep(ABSENCE_WINDOW_MS)
    expect(harness.fake.screen()).not.toContain(POLL_OUTPUT_MARK)
    expect(harness.fake.screen()).not.toContain('approvals list')
    expect(harness.fake.screen()).toContain(PLAIN_ACTION_TITLE)

    harness.fake.type('q')
    await expect(harness.exit).resolves.toBe(EXIT_OK)
  })
})

describe('runConsole: an action that leaves the console', () => {
  test('a reopen ends the console with 0, leaves the argv in the cell and restores the terminal', async () => {
    const reopen = createReopenCell()
    const dispatch = countingDispatch()
    const harness = startConsole({
      dispatch: dispatch.fn,
      reopen,
      token: await sessionCell(),
      initial: (size) => mainModelOf([REOPEN_SECTION], size),
    })
    await waitForScreen(harness.fake, (screen) => screen.includes('setup'), 'the reopening tab')

    harness.fake.type('\r')

    await expect(harness.exit).resolves.toBe(EXIT_OK)
    expect(reopen.get()).toEqual(['setup'])
    expect(harness.fake.restored()).toBe(true)
    // Nothing was run from inside the console: the child gets the terminal.
    expect(dispatch.countOf('setup')).toBe(0)
  })
})

describe('createLoop: a fault after the console was already leaving', () => {
  test('a reopen is taken back when the runtime faults: nothing is spawned on a crashed console', async () => {
    // `finish` is first-call-wins, so a fault arriving after the reopen leaves
    // the exit code at 0 with the stack only on stderr — and `tui-cmd.ts` would
    // then hand the terminal to `mcpcut setup` from a console that crashed.
    const reopen = createReopenCell()
    const fake = createFakeTerminal()
    const stderr = captureStderr()
    const base = depsOf(
      fake.terminal,
      new EventEmitter(),
      stderr,
      quietDispatch,
      plainStyle,
      await sessionCell(),
      reopen,
    )
    const loop = createLoop({
      ...base,
      initial: (size) => mainModelOf([REOPEN_SECTION], size),
    })
    loop.step({ kind: 'key', key: { kind: 'enter' } })
    expect(reopen.get()).toEqual(['setup'])

    loop.fail(new Error('the pure core threw'))

    expect(reopen.get()).toBeUndefined()
    loop.reportFault()
    expect(stderr.text()).toContain('the pure core threw')
  })
})
