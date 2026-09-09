import { roleSatisfies, type Role } from '../../admin/authz.js'
import { EXTERNAL_SUPERVISOR } from '../../services/constants.js'
import { DEFAULT_INSTALL_FACTS, type InstallFacts } from '../model.js'
import { ADMINS_SECTION } from './admins.js'
import { AGENTS_SECTION } from './agents.js'
import { APPROVALS_SECTION } from './approvals.js'
import { AUDIT_SECTION } from './audit.js'
import { GROUPS_SECTION } from './groups.js'
import { HOME_SECTION } from './home.js'
import { JOURNAL_SECTION } from './journal.js'
import { POLICY_SECTION } from './policy.js'
import { QUARANTINE_SECTION } from './quarantine.js'
import { SERVERS_SECTION } from './servers.js'
import { SERVICES_SECTION } from './services.js'
import { VAULT_SECTION } from './vault.js'
import type { ActionSpec, CommandPair, SectionSpec } from './types.js'

/**
 * The catalogue as the console reads it (mcpcut phase 2, Task 6): the ordered
 * sections, and the four pure lookups every screen is drawn from.
 *
 * `roleSatisfies` (`src/admin/authz.ts`) is the ONLY role comparison in the
 * console. The rank order lives in one place for every surface — the web UI
 * routes, the CLI's `approvals approve|deny`, and now this — because a second
 * answer to "who outranks whom" is the kind of drift that survives the people
 * who wrote it.
 */

export type { ActionSpec, CommandPair, SectionSpec } from './types.js'

/**
 * The sections, in the order the tab bar shows them — the order of the PRD's
 * "sections → actions → commands" table (mcpcut phase 4, Task 10). Services
 * (phase 5) takes the twelfth place.
 */
export const SECTIONS: readonly SectionSpec[] = [
  HOME_SECTION,
  ADMINS_SECTION,
  SERVERS_SECTION,
  VAULT_SECTION,
  AGENTS_SECTION,
  GROUPS_SECTION,
  POLICY_SECTION,
  QUARANTINE_SECTION,
  APPROVALS_SECTION,
  JOURNAL_SECTION,
  AUDIT_SECTION,
  SERVICES_SECTION,
]

/**
 * The sections a role may use on THIS install: the section must meet its own
 * threshold, keep at least one action the role may run, and offer only what
 * the install can actually do. A tab whose every action would be hidden is a
 * dead end, and the console shows none.
 *
 * The facts come last and default to "mcpcut supervises itself", so every
 * caller written before phase 5 keeps its meaning — and, more to the point,
 * an install with nothing to hide gets the very SAME section objects back.
 */
export function visibleSections(
  role: Role,
  sections: readonly SectionSpec[] = SECTIONS,
  facts: InstallFacts = DEFAULT_INSTALL_FACTS,
): readonly SectionSpec[] {
  return sections
    .map((section) => narrowedByFacts(section, facts))
    .filter(
      (section) => roleSatisfies(role, section.minRole) && visibleActions(section, role).length > 0,
    )
}

/**
 * The section with the actions this install cannot offer taken out — and the
 * SAME object when nothing is taken out, so the common case allocates nothing
 * and identity comparisons in tests and renderers stay meaningful.
 */
function narrowedByFacts(section: SectionSpec, facts: InstallFacts): SectionSpec {
  const actions = section.actions.filter((action) => meetsRequirement(action, facts))
  return actions.length === section.actions.length ? section : { ...section, actions }
}

/**
 * Whether the install is the kind of install an action needs. Only
 * `'own-supervisor'` exists today: under `supervisor: external` compose or
 * systemd owns the two processes and mcpcut merely reports on them (Q16), so
 * `start` and `stop` are not offered at all rather than offered and refused.
 */
export function meetsRequirement(action: ActionSpec, facts: InstallFacts): boolean {
  if (action.requires === undefined) return true

  return action.requires === 'own-supervisor' && facts.supervisor !== EXTERNAL_SUPERVISOR
}

/**
 * The section's refresh action: the one `r` re-runs and the one the Approvals
 * timer polls, when the section names one, this role may run it, and it needs
 * no arguments. An action with fields cannot be re-run by a keystroke or a
 * tick — there would be nothing to fill them with.
 *
 * A refresh RUNS HERE, so an action that leaves the console cannot be one. `r`
 * and the tick dispatch in-process while the console owns the alternate
 * screen; `leavesConsole` means the argv has to be reopened as a child on the
 * bare terminal instead (ADR-0012 §16). Without this rule a one-word catalogue
 * edit — `refreshActionId: 'setup'` — would have a keystroke and a timer run
 * the wizard underneath the frame.
 *
 * It lives here rather than in a reducer because two callers now ask the same
 * question (`update-main.ts` on `r`, `subscriptions.ts` on every step), and
 * two answers to "what does this tab re-read" is the kind of drift that shows
 * up as a tab polling something it will not redraw.
 */
export function refreshActionOf(
  sections: readonly SectionSpec[],
  role: Role,
  sectionIndex: number,
): ActionSpec | undefined {
  const section = sections[sectionIndex]
  if (section === undefined || section.refreshActionId === undefined) return undefined

  const action = visibleActions(section, role).find((each) => each.id === section.refreshActionId)
  if (action === undefined || action.leavesConsole === true) return undefined

  return action.fields.length === 0 ? action : undefined
}

/** The actions of one section a role may run. */
export function visibleActions(section: SectionSpec, role: Role): readonly ActionSpec[] {
  return section.actions.filter((action) => roleSatisfies(role, action.minRole))
}

/**
 * Every command the catalogue can run, deduplicated and in catalogue order.
 *
 * This is what `tests/tui/catalogue-parity.test.ts` subtracts from the pairs
 * it reads out of `USAGE`, so that each command still missing from the
 * console is a listed omission rather than one nobody noticed.
 */
export function cataloguePairs(sections: readonly SectionSpec[] = SECTIONS): readonly CommandPair[] {
  const seen = new Set<string>()

  return sections.flatMap((section) =>
    section.actions.flatMap((action) => {
      const key = pairKeyOf(action)
      if (seen.has(key)) return []

      seen.add(key)
      return [pairOf(action)]
    }),
  )
}

function pairOf(action: ActionSpec): CommandPair {
  return action.subcommand === undefined
    ? { command: action.command }
    : { command: action.command, subcommand: action.subcommand }
}

function pairKeyOf(pair: CommandPair): string {
  return `${pair.command}\0${pair.subcommand ?? ''}`
}

/**
 * The action a section cursor and an action cursor point at, or `undefined`
 * when either index is outside what this role may see.
 *
 * Both thresholds are re-checked here rather than trusted from the caller:
 * this is the one place a keystroke turns into a command line, and it must
 * answer the same way whether it is handed the whole catalogue or the
 * filtered list a frame was drawn from.
 */
export function actionAt(
  sections: readonly SectionSpec[],
  role: Role,
  sectionIndex: number,
  actionIndex: number,
): ActionSpec | undefined {
  const section = sections[sectionIndex]
  if (section === undefined || !roleSatisfies(role, section.minRole)) return undefined

  return visibleActions(section, role)[actionIndex]
}
