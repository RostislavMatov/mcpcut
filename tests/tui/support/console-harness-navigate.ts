import type { Role } from '../../../src/admin/authz.js'
import { visibleActions, visibleSections } from '../../../src/tui/catalogue/index.js'
import { CLI_NAME } from '../../../src/setup/constants.js'
import {
  ACTION_COLUMN_WIDTH,
  ACTIVE_MARKER,
  exitLine,
  FOOTER_ROWS,
  FORM_HELP_FOOTER,
  HEADER_ROWS,
  SIGNIN_TITLE,
} from '../../../src/tui/constants.js'
import { waitForScreen, type FakeTerminal } from './fake-terminal.js'

/**
 * The half of the console harness that presses keys and reads frames.
 *
 * Split out of `console-harness.ts` when the file passed 400 lines: that one
 * builds the STAND (a console wired to a temp directory), this one is the
 * OPERATOR (what they press, and what they wait to see). The dependency runs
 * one way — the stand imports the operator's `RunningConsole` shape and
 * re-exports everything here, so a suite keeps importing
 * `./support/console-harness.js` alone.
 *
 * Two rules everything below obeys:
 *
 * Navigation goes by the action COLUMN, never by the tab bar. The bar is a
 * window over eleven labels whose rendering is its own concern (`tabs.ts`);
 * a test that pinned its exact string would break whenever the window did,
 * while what a test actually means is "the section whose actions these are".
 * `tabsLineOf` is the exception, for the two tests that are ABOUT the bar.
 *
 * Every wait is a predicate over a drawn frame (`waitForScreen`), never a
 * sleep: a keystroke becomes a frame after a decode, a reducer step and — for
 * anything that runs — a whole CLI invocation, and a fixed wait would be
 * either flaky or slow.
 */

/** The terminal size every console in these suites reports. */
export const CONSOLE_COLUMNS = 80
export const CONSOLE_ROWS = 24

/** Rows between the header band and the footer line — the action column's height. */
const BODY_ROWS = CONSOLE_ROWS - HEADER_ROWS - FOOTER_ROWS

/**
 * How long a dispatched command may take before the wait gives up. Longer
 * than `waitForScreen`'s own default: the first command of a suite opens (and
 * creates) two SQLite databases, which the later ones no longer pay for.
 */
export const RUN_TIMEOUT_MS = 3_000

/** The keys the suites press, named so the steps read as steps. */
export const ENTER = '\r'
export const INTERRUPT = '\x03'
export const TAB = '\t'
export const RIGHT_ARROW = '\x1b[C'
export const SPACE = ' '
export const DOWN_KEY = 'j'
export const UP_KEY = 'k'
export const QUIT_KEY = 'q'
export const REFRESH_KEY = 'r'
export const YES_KEY = 'y'
export const NO_KEY = 'n'

/** The highest section a digit can name (`1`–`9` in `update-main.ts`). */
const LAST_DIGIT_INDEX = 8

/** What the pane prefixes the command still in flight with (`render-panes.ts`). */
const RUNNING_MARK = 'running: $ '

/** A console a suite has open, as the steps below drive it. */
export interface RunningConsole {
  readonly fake: FakeTerminal
  /** Resolves with the console's exit code; never rejects. */
  readonly exit: Promise<number>
  /** Every argv the console handed the dispatcher, in order. */
  argvCalls(): readonly (readonly string[])[]
  errText(): string
  /** Asks the console to leave and waits for it, however the test ended. */
  close(): Promise<void>
}

/** The current frame as lines, so a test can read one band of the screen. */
export function screenLines(fake: FakeTerminal): readonly string[] {
  return fake.screen().split('\n')
}

/**
 * The tab bar: the second row of the main screen, without its padding.
 *
 * For the two tests that assert what the BAR shows — that eleven owner
 * sections do not fit 80 columns and scroll, and that a viewer's digit 2 is
 * Servers because Admins was never numbered for them. Everything else finds
 * its section with `goToSection`.
 */
export function tabsLineOf(fake: FakeTerminal): string {
  return (screenLines(fake)[1] ?? '').trimEnd()
}

/**
 * The titles in the action column of a drawn frame, top to bottom.
 *
 * The body band is a fixed height, so the rows are taken by index rather than
 * by trying to tell a footer from an action — and each row's first
 * `ACTIVE_MARKER.length` characters are the cursor gutter, not the title.
 */
export function actionTitlesIn(screen: string): readonly string[] {
  return screen
    .split('\n')
    .slice(HEADER_ROWS, HEADER_ROWS + BODY_ROWS)
    .map((line) => line.slice(ACTIVE_MARKER.length, ACTION_COLUMN_WIDTH).trimEnd())
    .filter((title) => title !== '')
}

/** Which of `actionTitlesIn`'s entries the cursor is on, or `-1` when none is. */
export function activeActionIndexIn(screen: string): number {
  return screen
    .split('\n')
    .slice(HEADER_ROWS, HEADER_ROWS + BODY_ROWS)
    .filter((line) => line.slice(ACTIVE_MARKER.length, ACTION_COLUMN_WIDTH).trimEnd() !== '')
    .findIndex((line) => line.startsWith(ACTIVE_MARKER))
}

/** Signs in with `token` and waits for the header that says who is signed in. */
export async function signIn(
  app: RunningConsole,
  token: string,
  name: string,
  role: Role,
): Promise<void> {
  const { fake } = app
  await waitForScreen(fake, (screen) => screen.includes(SIGNIN_TITLE), 'the sign-in screen')
  fake.type(`${token}${ENTER}`)
  await waitForScreen(
    fake,
    (screen) => screen.includes(`${name} (${role})`),
    `the header naming ${name}`,
  )
}

/**
 * Opens the section with `sectionId`, and waits until its actions are the ones
 * in the column.
 *
 * A digit jumps straight to any of the first nine sections; the tenth and
 * eleventh are `Tab` steps past the ninth. Both are what an operator presses,
 * and neither reads the tab bar.
 *
 * One documented limitation: it returns at once when the actions on screen are
 * already the ones it was asked for. Two sections with an identical list of
 * visible actions are therefore indistinguishable to it (a viewer sees
 * `list`/`show` in both Servers and Quarantine). A suite that must navigate
 * between such a pair should press its own keys.
 */
export async function goToSection(
  app: RunningConsole,
  sectionId: string,
  role: Role,
): Promise<void> {
  const sections = visibleSections(role)
  const index = sections.findIndex((section) => section.id === sectionId)
  const section = sections[index]
  if (section === undefined) throw new Error(`role "${role}" has no "${sectionId}" section`)

  const titles = visibleActions(section, role).map((action) => action.title)
  const isThere = (screen: string): boolean => sameTitles(actionTitlesIn(screen), titles)
  if (isThere(app.fake.screen())) return

  const digit = Math.min(index, LAST_DIGIT_INDEX)
  app.fake.type(String(digit + 1))
  for (let step = digit; step < index; step += 1) app.fake.type(TAB)

  await waitForScreen(app.fake, isThere, `the ${sectionId} section`)
}

function sameTitles(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((title, i) => title === expected[i])
}

/** Moves the action cursor onto `title` and opens it with Enter. */
export async function chooseAction(app: RunningConsole, title: string): Promise<void> {
  const screen = app.fake.screen()
  const target = actionTitlesIn(screen).indexOf(title)
  if (target < 0) throw new Error(`no action "${title}" on screen:\n${screen}`)

  const current = activeActionIndexIn(screen)
  const key = target > current ? DOWN_KEY : UP_KEY
  for (let step = 0; step < Math.abs(target - current); step += 1) app.fake.type(key)

  await waitForScreen(
    app.fake,
    (drawn) => activeActionIndexIn(drawn) === target,
    `the "${title}" action to be selected`,
  )
  app.fake.type(ENTER)
}

/** One action of a section, as a test asks for it to be run. */
export interface ActionRun {
  /** The title in the action column. */
  readonly title: string
  /**
   * One entry per field of the form, in the order the form declares them,
   * typed with `Tab` between. An entry is raw bytes: text for a text field,
   * `RIGHT_ARROW` for a choice, `SPACE` for a flag, `''` to leave one as it
   * is. Fields past the last entry keep their starting values.
   *
   * PRESENCE is what says the action has a form: an action whose fields are
   * all optional still opens one and still needs the Enter that submits it,
   * so it is asked for with `values: []`. An action with no fields at all
   * runs straight from the first Enter and leaves this out.
   */
  readonly values?: readonly string[]
  /**
   * What the pane prints after `$ mcpcut `, or a prefix of it — the pane is 54
   * columns wide and cuts a command line with a long path in it.
   */
  readonly command: string
  readonly exitCode?: number
  readonly timeoutMs?: number
}

/** Runs one action of the section on screen and waits for its exit line. */
export async function runAction(app: RunningConsole, run: ActionRun): Promise<void> {
  await submitAction(app, run)
  await waitForRun(app, run)
}

/**
 * Everything up to and including the Enter that submits the form — for an
 * action whose next screen is a confirmation rather than a finished run.
 */
export async function submitAction(app: RunningConsole, run: ActionRun): Promise<void> {
  await chooseAction(app, run.title)

  const { values } = run
  if (values === undefined) return

  await waitForScreen(
    app.fake,
    (screen) => screen.includes(FORM_HELP_FOOTER),
    `the "${run.title}" form`,
  )
  app.fake.type(`${values.join(TAB)}${ENTER}`)
}

/** Waits for the output pane to show a FINISHED run of `run.command`. */
export async function waitForRun(app: RunningConsole, run: ActionRun): Promise<void> {
  await waitForFinishedRun(app, run.command, run.exitCode ?? 0, run.timeoutMs ?? RUN_TIMEOUT_MS)
}

/**
 * Waits until the pane shows `command` finished with `exitCode`, and nothing
 * is in flight.
 *
 * "Finished" has to be the ABSENCE of the running line rather than the
 * presence of an exit code: while a command runs the pane still shows the
 * previous run's panel underneath, exit line and all. It also has to be
 * waited for before a test presses anything else — `update.ts` makes the
 * keyboard deaf while a run is in flight, `Ctrl-C` excepted, so a `q` pressed
 * a moment early is not a slow quit but no quit at all.
 *
 * `command` may be a PREFIX: the pane is 54 columns wide and cuts a command
 * line with a long path in it.
 */
export async function waitForFinishedRun(
  app: RunningConsole,
  command: string,
  exitCode = 0,
  timeoutMs: number = RUN_TIMEOUT_MS,
): Promise<void> {
  const line = `$ ${CLI_NAME} ${command}`
  const exit = exitLine(exitCode)

  await waitForScreen(
    app.fake,
    (screen) => !screen.includes(RUNNING_MARK) && screen.includes(line) && screen.includes(exit),
    `"${command}" to finish with ${exit}`,
    timeoutMs,
  )
}

/** Waits for a pane holding `fragment` — a confirmation question, say. */
export async function waitForText(
  app: RunningConsole,
  fragment: string,
  what: string,
  timeoutMs: number = RUN_TIMEOUT_MS,
): Promise<void> {
  await waitForScreen(app.fake, (screen) => screen.includes(fragment), what, timeoutMs)
}
