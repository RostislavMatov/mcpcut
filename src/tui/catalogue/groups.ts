import { AGENT_NAME_PATTERN, GRANT_SERVER_NAME_PATTERN } from '../../agents/constants.js'
import { ACCESS_MIN_ROLE } from '../../cli/access-cmd-write.js'
import { GROUP_NAME_PATTERN } from '../../groups/constants.js'
import { optionFlag, patternField, textField, valueOf } from './fields.js'
import type { ActionSpec, SectionSpec } from './types.js'

/**
 * The Groups section (mcpcut phase 4, Task 5): `group list|show|create|
 * remove|grant|ungrant|join|leave` as eight declarative actions.
 *
 * Reading is free (`viewer`), and every MUTATION is `ACCESS_MIN_ROLE` —
 * imported from `src/cli/access-cmd-write.ts`, the one row (G4) both this
 * console and `POST /groups/*` in the web UI answer from. A second copy of
 * `'owner'` typed here is exactly the drift ADR-0010 §4 exists to prevent.
 *
 * A group is grants of the same shape an agent carries, landing on every
 * member at once; a personal grant for the same server wins outright (G2).
 * There is no group TOKEN — the key stays personal, or the journal would
 * stop being able to say who made a call.
 *
 * The one place this section departs from Agents is `--tools`: owner decision
 * T2 (2026-09-01) made it REQUIRED for a group grant, because the cost of a
 * mistaken `'*'` is multiplied by the member count. The field is `required`
 * so the operator learns that on the form rather than from a refusal.
 */

/** Group names: the registry/agent name shape, character for character. */
const groupField = patternField('group', 'Group', GROUP_NAME_PATTERN)

/** The member of a `join`/`leave`, validated by the agents store's own pattern. */
const agentField = patternField('agent', 'Agent', AGENT_NAME_PATTERN)

/** The server a grant names; existence is the command's answer, not the form's. */
const serverField = patternField('server', 'Server', GRANT_SERVER_NAME_PATTERN)

/**
 * `--tools` is required here and optional on `agent grant` — the asymmetry of
 * `src/cli/grant-flags.ts`, stated in the hint so the difference is visible
 * on the screen and not only in a refusal. `--resources`/`--prompts` keep the
 * fail-closed default they have everywhere: absent means DENIED.
 */
const toolsField = textField('tools', 'Tools', 'comma-separated, or *; required here', true)
const resourcesField = textField('resources', 'Resources', 'URI patterns or *; empty = denied')
const promptsField = textField('prompts', 'Prompts', 'patterns or *; empty = denied')

const listAction: ActionSpec = {
  id: 'list',
  title: 'list',
  minRole: 'viewer',
  command: 'group',
  subcommand: 'list',
  fields: [],
  argv: () => ['group', 'list'],
}

const showAction: ActionSpec = {
  id: 'show',
  title: 'show',
  minRole: 'viewer',
  command: 'group',
  subcommand: 'show',
  fields: [groupField],
  argv: (values) => ['group', 'show', valueOf(values, 'group')],
}

const createAction: ActionSpec = {
  id: 'create',
  title: 'create',
  minRole: ACCESS_MIN_ROLE,
  command: 'group',
  subcommand: 'create',
  fields: [groupField],
  argv: (values) => ['group', 'create', valueOf(values, 'group')],
}

const removeAction: ActionSpec = {
  id: 'remove',
  title: 'remove',
  minRole: ACCESS_MIN_ROLE,
  command: 'group',
  subcommand: 'remove',
  fields: [groupField],
  argv: (values) => ['group', 'remove', valueOf(values, 'group')],
  confirm: (values) =>
    `Remove group "${valueOf(values, 'group')}"? (refused while it still has members)`,
}

const grantAction: ActionSpec = {
  id: 'grant',
  title: 'grant',
  minRole: ACCESS_MIN_ROLE,
  command: 'group',
  subcommand: 'grant',
  fields: [groupField, serverField, toolsField, resourcesField, promptsField],
  argv: (values) => [
    'group',
    'grant',
    valueOf(values, 'group'),
    valueOf(values, 'server'),
    '--tools',
    valueOf(values, 'tools'),
    ...optionFlag(values, 'resources', '--resources'),
    ...optionFlag(values, 'prompts', '--prompts'),
  ],
}

const ungrantAction: ActionSpec = {
  id: 'ungrant',
  title: 'ungrant',
  minRole: ACCESS_MIN_ROLE,
  command: 'group',
  subcommand: 'ungrant',
  fields: [groupField, serverField],
  argv: (values) => ['group', 'ungrant', valueOf(values, 'group'), valueOf(values, 'server')],
}

const joinAction: ActionSpec = {
  id: 'join',
  title: 'join',
  minRole: ACCESS_MIN_ROLE,
  command: 'group',
  subcommand: 'join',
  fields: [groupField, agentField],
  argv: (values) => ['group', 'join', valueOf(values, 'group'), valueOf(values, 'agent')],
}

const leaveAction: ActionSpec = {
  id: 'leave',
  title: 'leave',
  minRole: ACCESS_MIN_ROLE,
  command: 'group',
  subcommand: 'leave',
  fields: [groupField, agentField],
  argv: (values) => ['group', 'leave', valueOf(values, 'group'), valueOf(values, 'agent')],
}

/** Server groups: grants handed out by the handful, membership by the name. */
export const GROUPS_SECTION: SectionSpec = {
  id: 'groups',
  title: 'Groups',
  minRole: 'viewer',
  intro: [
    'Server groups: grants that land on every member;',
    'a personal grant for the same server wins.',
  ],
  actions: [
    listAction,
    showAction,
    createAction,
    removeAction,
    grantAction,
    ungrantAction,
    joinAction,
    leaveAction,
  ],
  refreshActionId: 'list',
}
