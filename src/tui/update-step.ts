import type { SectionSpec } from './catalogue/types.js'
import type { KeyEvent } from './keys.js'
import { bodyLayoutOf } from './layout.js'
import type {
  Effect,
  Model,
  Pane,
  RunRequest,
  Screen,
  Session,
  Step,
  TerminalSize,
} from './model.js'
import type { OutputPanel } from './output.js'
import type { ServiceSummary } from './services-summary.js'

/**
 * The constructors the four reducer modules share (mcpcut phase 2, Task 9).
 *
 * A leaf on purpose: `update.ts` routes to `update-signin.ts` and
 * `update-main.ts`, which routes to `update-form.ts`, so anything all of them
 * need has to sit below the lot of them or close a cycle.
 *
 * `mainOf`/`fieldsOf` exist because of `exactOptionalPropertyTypes`: "no run
 * in flight" is the ABSENCE of `busy`, not `busy: undefined`, and a spread
 * cannot express the difference. Rebuilding the screen from a record where
 * every optional field is explicit keeps that in ONE place instead of in every
 * branch that finishes a run or forgets a service line.
 */

/** The main screen, named once so the reducers need not re-`Extract` it. */
import type { MainScreen } from './model.js'

export type { MainScreen } from './model.js'

/** Where every pane returns to. */
export const ACTIONS_PANE: Pane = { kind: 'actions' }

/** Rows a page of output takes besides the pane: the command line and `exit N`. */
const PANE_CHROME_ROWS = 2

/** A page never scrolls by nothing, however short the terminal is. */
const MIN_PAGE_ROWS = 1

/** The model as it stands, with nothing asked of the runtime. */
export function noEffects(model: Model): Step {
  return { model, effects: [] }
}

/** The model with another screen, and whatever that change asks the runtime for. */
export function withScreen(model: Model, screen: Screen, effects: readonly Effect[] = []): Step {
  return { model: { ...model, screen }, effects }
}

/** Leaves the console with `exitCode`; the runtime restores the terminal. */
export function quit(model: Model, exitCode: number): Step {
  return { model, effects: [{ kind: 'quit', exitCode }] }
}

/** The Ctrl-D chord: "disconnect" on a remote console, nothing at all locally (2026-09-20). */
const DISCONNECT_CHAR = 'd'

/** Whether a keystroke is the Ctrl-D "disconnect" chord. */
export function isDisconnectKey(key: KeyEvent): boolean {
  return key.kind === 'ctrl' && key.char === DISCONNECT_CHAR
}

/** Whether this console is driving a remote install (`InstallFacts.remote`, ADR-0014). */
export function isRemoteInstall(model: Model): boolean {
  return model.install?.remote === true
}

/**
 * Leaves the console: forgets the saved address, if any, and reopens on
 * `--connect <the address this console was driving>` (2026-09-20, owner
 * request "a way to disconnect"). Shared by Home's `disconnect` action
 * (`update-form.ts`) and the Ctrl-D chord on the sign-in and first-owner
 * screens (`update-signin.ts`, `update-first-owner.ts`) — one builder, so the
 * address a keystroke reopens on can never disagree with the one a menu item
 * would have.
 */
export function disconnectStep(model: Model): Step {
  return { model, effects: [{ kind: 'disconnect', argv: ['--connect', model.install?.remoteAddress ?? ''] }] }
}

/**
 * How many lines of output one PgUp/PgDn moves on a terminal this size. Read
 * off the layout rather than the height alone since phase 6: on a narrow
 * terminal the action band takes rows from the pane, and a page that moved
 * by the two-column count would skip lines the pane never showed.
 */
export function pageRowsOf(size: TerminalSize): number {
  return Math.max(MIN_PAGE_ROWS, bodyLayoutOf(size).paneRows - PANE_CHROME_ROWS)
}

/** Every field of a main screen, with `undefined` meaning "this one is absent". */
export interface MainFields {
  readonly session: Session
  readonly sections: readonly SectionSpec[]
  readonly sectionIndex: number
  readonly actionIndex: number
  readonly pane: Pane
  readonly output: OutputPanel | undefined
  readonly services: readonly ServiceSummary[] | undefined
  readonly busy: RunRequest | undefined
  /** Id of the section a quiet poll is out for; `undefined` = none in flight. */
  readonly polling: string | undefined
  /** Keys queued while a run was in flight, oldest first; `undefined` = nothing queued. */
  readonly pendingKeys: readonly KeyEvent[] | undefined
}

/** Reads a main screen into the record `mainOf` builds one from. */
export function fieldsOf(screen: MainScreen): MainFields {
  return {
    session: screen.session,
    sections: screen.sections,
    sectionIndex: screen.sectionIndex,
    actionIndex: screen.actionIndex,
    pane: screen.pane,
    output: screen.output,
    services: screen.services,
    busy: screen.busy,
    polling: screen.polling,
    pendingKeys: screen.pendingKeys,
  }
}

/** Builds a main screen, leaving out every field the record has no value for. */
export function mainOf(fields: MainFields): MainScreen {
  return {
    kind: 'main',
    session: fields.session,
    sections: fields.sections,
    sectionIndex: fields.sectionIndex,
    actionIndex: fields.actionIndex,
    pane: fields.pane,
    ...(fields.output !== undefined ? { output: fields.output } : {}),
    ...(fields.services !== undefined ? { services: fields.services } : {}),
    ...(fields.busy !== undefined ? { busy: fields.busy } : {}),
    ...(fields.polling !== undefined ? { polling: fields.polling } : {}),
    ...(fields.pendingKeys !== undefined ? { pendingKeys: fields.pendingKeys } : {}),
  }
}

/**
 * One step of the main screen: the fields that changed, and the effects the
 * change asks for. Passing `undefined` for a field removes it.
 */
export function withMain(
  model: Model,
  screen: MainScreen,
  changes: Partial<MainFields>,
  effects: readonly Effect[] = [],
): Step {
  return withScreen(model, mainOf({ ...fieldsOf(screen), ...changes }), effects)
}
