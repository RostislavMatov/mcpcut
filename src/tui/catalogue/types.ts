import type { Role } from '../../admin/authz.js'
import type { FieldSpec, FormValues } from '../form.js'

/**
 * The vocabulary of the console's catalogue (mcpcut phase 2, Task 6).
 *
 * A section is a screen's worth of the CLI, an action is one command on it,
 * and both are DATA: no handler, no closure over a store, nothing that could
 * run a command a different way than the shell would. The console executes an
 * action by building `argv` and handing it to the same `dispatch()` the shell
 * calls, which is what lets the output pane print the command line it ran and
 * have that line be true.
 *
 * Types only — the sections themselves live in `./home.ts` and `./admins.ts`,
 * and `./index.ts` is what the model reads.
 */

/**
 * A command of the CLI as the catalogue names it: `admin add` is
 * `{ command: 'admin', subcommand: 'add' }`, `status` has no subcommand.
 *
 * This is the unit the parity test (`tests/tui/catalogue-parity.test.ts`)
 * compares against the pairs it extracts from `USAGE`, so that a command the
 * console cannot yet run is a listed omission rather than an oversight.
 */
export interface CommandPair {
  readonly command: string
  readonly subcommand?: string
}

/** One runnable command: the form that collects its arguments, and the argv it builds. */
export interface ActionSpec extends CommandPair {
  /** Stable key of the action inside its section (also what `refreshActionId` names). */
  readonly id: string
  /** Label in the action column. */
  readonly title: string
  /**
   * Minimum role that may SEE and run the action. A UX filter mirroring
   * `ROUTE_TABLE`, nothing more: the command itself re-checks the token the
   * console passes through the environment seam (`approvals`, `policy set`,
   * `agent`, `group`, `vault`, `server`, and since the owner decision of
   * 2026-09-06 `admin` too), which is where the real answer is given. A
   * threshold here only keeps a screen free of dead ends.
   */
  readonly minRole: Role
  /** Fields the operator fills in before the action runs; empty means "run at once". */
  readonly fields: readonly FieldSpec[]
  /**
   * The command line to run. MUST return a NEW array on every call: the
   * runtime keeps the argv it ran beside the output, and a shared array would
   * let the next run rewrite the last one's printed command.
   */
  readonly argv: (values: FormValues) => readonly string[]
  /** Question to answer before the action runs; absent means it runs unasked. */
  readonly confirm?: (values: FormValues) => string
  /** One line under the action's title, when the title alone is not enough. */
  readonly hint?: string
}

/** One tab of the console: a title, an intro and the actions under it. */
export interface SectionSpec {
  /** Stable key of the section (frames and tests name it, not its index). */
  readonly id: string
  /** Label in the tab bar. */
  readonly title: string
  /** Minimum role that may see the section at all. */
  readonly minRole: Role
  /** Lines the pane shows before anything has been run. */
  readonly intro: readonly string[]
  readonly actions: readonly ActionSpec[]
  /** Action re-run by the `r` key, when the section has one that reads its own state. */
  readonly refreshActionId?: string
}
