import type { Role } from '../../../src/admin/authz.js'
import { visibleSections } from '../../../src/tui/catalogue/index.js'
import type { SectionSpec } from '../../../src/tui/catalogue/types.js'
import { ONE_TIME_TOKEN_MARKER } from '../../../src/tui/constants.js'
import type { KeyEvent, NamedKey } from '../../../src/tui/keys.js'
import {
  mainScreenOf,
  type InstallFacts,
  type Model,
  type Msg,
  type Screen,
  type Session,
  type TerminalSize,
} from '../../../src/tui/model.js'
import { outputPanelOf, type OutputPanel, type RunResult } from '../../../src/tui/output.js'
import { defaultInstallConfig } from '../../../src/setup/defaults.js'
import { update } from '../../../src/tui/update.js'
import { wizardScreenOf } from '../../../src/tui/wizard-fields.js'

/**
 * Fixtures the reducer suites share: `update.test.ts` (entry point, sign-in
 * screen, the two invariant tables), `update-sections.test.ts` (sections,
 * actions, runs, `r`), `update-output.test.ts` (scrolling, help and quit) and
 * `update-form.test.ts` (form and confirmation panes, what a run carries).
 * Lifted out of `update.test.ts` when it was split (phase 6, task 9, F9):
 * the message builders, the screen builders and the two model walkers every
 * one of those files reaches for. Nothing here touches a terminal, a store or
 * a clock.
 */

export const SIZE: TerminalSize = { columns: 80, rows: 24 }

/** Stdout of a command that minted a token: what makes `q` ask before quitting. */
export const ONE_TIME_STDOUT = `token: mcpa_x\n${ONE_TIME_TOKEN_MARKER}\n`
export const SESSION: Session = { adminName: 'root', role: 'owner' }

/**
 * Index of the sections an owner sees, in the order the tab bar shows them:
 * home, admins, servers, vault, agents, groups, policy, quarantine,
 * approvals, journal, audit, services. Only the first nine have a digit key —
 * `10`, `11` and `12` cannot be typed as one keystroke, so Audit and Services
 * are reached by Tab alone.
 */
export const HOME_TAB = 0
export const ADMINS_TAB = 1
export const SERVERS_TAB = 2
export const VAULT_TAB = 3
export const APPROVALS_TAB = 8
export const JOURNAL_TAB = 9
export const AUDIT_TAB = 10
export const SERVICES_TAB = 11

/** What the catalogue sections are called, in that same order. */
export const OWNER_SECTION_IDS: readonly string[] = [
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
  'services',
]

/** The sections a viewer sees: the owner's list without Admins and Vault. */
export const VIEWER_SECTION_IDS: readonly string[] = OWNER_SECTION_IDS.filter(
  (id) => id !== 'admins' && id !== 'vault',
)

/** An index past the last section: what a cursor left over from another role looks like. */
export const NO_SUCH_TAB = OWNER_SECTION_IDS.length

/** Index of the actions the cases below open by their position in a section. */
export const VAULT_SET_ACTION = 2
export const JOURNAL_EXPORT_ACTION = 2
export const AUDIT_PRUNE_ACTION = 6

/** A vault value: long enough that finding it in a frame could not be a coincidence. */
export const VAULT_SECRET = 'sk-live-do-not-print-me'

export type MainScreen = Extract<Screen, { kind: 'main' }>
export type SigninScreen = Extract<Screen, { kind: 'signin' }>

export function key(kind: NamedKey): Msg {
  return { kind: 'key', key: { kind } as KeyEvent }
}

export function char(value: string): Msg {
  return { kind: 'key', key: { kind: 'char', char: value } }
}

export function ctrl(value: string): Msg {
  return { kind: 'key', key: { kind: 'ctrl', char: value } }
}

export function typed(model: Model, text: string): Model {
  return [...text].reduce((current, letter) => update(current, char(letter)).model, model)
}

export function mainScreen(patch: Partial<MainScreen> = {}, role: Role = 'owner', facts?: InstallFacts): MainScreen {
  const screen = mainScreenOf({ ...SESSION, role }, visibleSections(role, undefined, facts))
  if (screen.kind !== 'main') throw new Error('mainScreenOf must build a main screen')

  return { ...screen, ...patch }
}

export function mainModel(patch: Partial<MainScreen> = {}, role: Role = 'owner', install?: InstallFacts): Model {
  return { screen: mainScreen(patch, role, install), size: SIZE, ...(install === undefined ? {} : { install }) }
}

/**
 * A wizard on its form. The stage-by-stage behaviour is asserted in
 * `update-wizard.test.ts`; what belongs here is that `update` routes to it and
 * that its branches keep the invariants the other screens keep.
 */
export function wizardModel(): Model {
  const config = defaultInstallConfig('/var/lib/x')
  const screen = wizardScreenOf({ mode: 'first-run', configPath: '/home/op/.mcpcut/config.json', config })

  return { screen, size: SIZE }
}

export function mainOf(model: Model): MainScreen {
  if (model.screen.kind !== 'main') throw new Error(`expected a main screen, got ${model.screen.kind}`)

  return model.screen
}

export function signinOf(model: Model): SigninScreen {
  if (model.screen.kind !== 'signin') throw new Error(`expected a sign-in screen, got ${model.screen.kind}`)

  return model.screen
}

export function panelOf(lineCount: number, overrides: Partial<RunResult> = {}): OutputPanel {
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
export const PLAIN_SECTION: SectionSpec = {
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
export function snapshotOf<T>(value: T): T {
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
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const each of Object.values(value)) deepFreeze(each)

  return Object.freeze(value)
}
