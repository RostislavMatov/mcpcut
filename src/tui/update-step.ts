import type { SectionSpec } from './catalogue/types.js'
import { FOOTER_ROWS, HEADER_ROWS } from './constants.js'
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

/** How many lines of output one PgUp/PgDn moves on a terminal this tall. */
export function pageRowsOf(size: TerminalSize): number {
  return Math.max(MIN_PAGE_ROWS, size.rows - HEADER_ROWS - FOOTER_ROWS - PANE_CHROME_ROWS)
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
