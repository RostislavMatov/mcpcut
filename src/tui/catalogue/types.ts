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

/**
 * Everything a runnable command carries whichever of the two shapes below it
 * is: the form that collects its arguments, and the argv it builds.
 *
 * Not exported: `ActionSpec` is the type a section declares, and the split
 * between the two is the point.
 */
interface ActionSpecCommon extends CommandPair {
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
  /**
   * Name of a field holding the path the command's stdout is written to
   * (`export`): the pane then shows a one-line summary instead of the text.
   */
  readonly stdoutToField?: string
  /** One line under the action's title, when the title alone is not enough. */
  readonly hint?: string
  /**
   * Hidden unless the install meets it: 'own-supervisor' = mcpcut runs the
   * daemons itself (`config.supervisor !== 'external'`).
   */
  readonly requires?: ActionRequirement
  /**
   * The command prints a credential ONCE (`TOKEN_ONCE_NOTICE`): `admin add`,
   * `admin rotate`, `agent create`. Only such an action may hold the
   * `token-hold` pane, and that is why this is a property of the ACTION rather
   * than of the bytes it printed. The marker is a plain English sentence, and
   * most tabs print text somebody else chose — `approvals list` prints the
   * arguments an agent sent, `journal show` and `logs` print upstream output —
   * so a substring match on stdout let anybody who could write that sentence
   * lock the console's pane behind a banner that was not true.
   *
   * It is a necessary condition, never a sufficient one: the panel holds only
   * when the action minted AND the marker really is in stdout, so a refused
   * `admin add` (which prints no token) returns to the action list.
   */
  readonly mintsToken?: true
  /**
   * Not dispatched from here: the console ends and argv runs as a child on the
   * same terminal (`setup` opens the wizard). Implies `fields: []` — the
   * confirm is the only question.
   */
  readonly leavesConsole?: true
}

/** What an install must be for an action to be offered at all. */
export type ActionRequirement = 'own-supervisor'

/**
 * One runnable command: the common members above, plus EITHER a question
 * asked before the run OR a secret handed to the run's stdin — never both.
 *
 * The exclusion is a security property, not a tidiness rule, which is why it
 * is a type and not only an assertion in
 * `tests/tui/catalogue-invariants.test.ts` (owner tail Q23). `confirm` parks
 * the filled form in the model until the operator answers; `stdinField` names
 * a `secret` field whose value the runtime hands straight to the command's
 * stdin reader (`vault set` → `VaultCmdDeps.readSecretInput`) so that it
 * reaches neither argv (i.e. `ps`), nor the "equivalent command" line, nor a
 * drawn frame. An action carrying both would make the confirm pane — the
 * model — the second place that secret lives. The runtime test still stands
 * beside this one: it also checks that `stdinField` names a field that really
 * is `secret`, which no type can say.
 *
 * `?: never` rather than `?: undefined`: under `exactOptionalPropertyTypes`
 * the absent property is the only way to write "this arm has none", and an
 * explicit `confirm: undefined` — a shape nothing in the catalogue writes —
 * is refused along with a real function.
 */
export type ActionSpec = ActionSpecCommon &
  (
    | {
        /**
         * Name of a `secret` field whose value is handed to the command's
         * stdin reader and NEVER put in argv.
         */
        readonly stdinField: string
        readonly confirm?: never
      }
    | {
        readonly stdinField?: never
        /**
         * Question to answer before the action runs; `undefined` (or absent)
         * means it runs unasked. The values are passed in because an action
         * can be destructive only for some of them — `prune --yes` answered
         * its own question on the form and must not be asked a second time.
         */
        readonly confirm?: (values: FormValues) => string | undefined
      }
  )

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
  /**
   * Replaces `intro` under `supervisor: external`, where the intro would advise
   * an action this install hides (Q32: Home's `Services ▸ start`).
   */
  readonly externalIntro?: readonly string[]
  readonly actions: readonly ActionSpec[]
  /** Action re-run by the `r` key, when the section has one that reads its own state. */
  readonly refreshActionId?: string
  /**
   * Re-run `refreshActionId` on its own every this many ms while the tab is
   * open on its action list (C3: Approvals only).
   */
  readonly autoRefreshMs?: number
}
