import { AGENT_NAME_PATTERN, GRANT_SERVER_NAME_PATTERN } from '../../agents/constants.js'
import { CLIENT_IDS } from '../../adopt/clients.js'
import { ACCESS_MIN_ROLE } from '../../cli/access-cmd-write.js'
import { HTTP_FLAG } from '../../cli/agent-config-cmd.js'
import { flagField, isOn, optionFlag, patternField, switchFlag, textField, valueOf } from './fields.js'
import type { FormValues } from '../form.js'
import type { ActionSpec, SectionSpec } from './types.js'

/**
 * The Agents section (mcpcut phase 4, Task 5): `agent list|create|config|
 * grant|ungrant|revoke` as six declarative actions plus the three `adopt` forms (`config` — ADR-0015, PRD
 * phase 4: the client config block with `<token>`, readable by anyone).
 *
 * Reading is free (`viewer`), and every MUTATION is `ACCESS_MIN_ROLE` —
 * imported from `src/cli/access-cmd-write.ts`, which is where owner decision
 * T4 (2026-09-01) put personal grants behind the same owner gate `group *`
 * already had. Importing the threshold rather than typing `'owner'` here is
 * the point: the console must not be able to disagree with the command it
 * runs about who may edit an identity.
 *
 * The threshold buys a screen without dead ends, nothing more. The real
 * answer is given one layer down — every `agent` mutation re-checks the
 * personal token the console passes through the environment seam and leaves
 * an `access-edit` journal record naming the admin (ADR-0010 §4). What the
 * token buys there is ATTRIBUTION rather than authority (ADR-0004).
 *
 * The name patterns are the store's own (`src/agents/constants.ts`), so the
 * form refuses exactly what `createAgent` would refuse, in the same words.
 */

/** Agent names: the lowercase DNS-label style the agents store enforces. */
const agentNameField = patternField('name', 'Name', AGENT_NAME_PATTERN)

/** The same shape under the name `agent`, for the two-positional actions. */
const agentRefField = patternField('agent', 'Agent', AGENT_NAME_PATTERN)

/**
 * The server a grant names. Whether it EXISTS is checked by the command
 * (`requireRegisteredServer`, owner decision S1) — the form only refuses a
 * name the store could never hold.
 */
const serverField = patternField('server', 'Server', GRANT_SERVER_NAME_PATTERN)

/**
 * The three grant flags, whose asymmetry is the security contract of
 * `src/cli/grant-flags.ts` rather than a formatting detail: an absent
 * `--tools` grants ALL tools, while an absent `--resources`/`--prompts`
 * leaves those surfaces DENIED. The hints say both out loud, because a form
 * that stayed quiet about it would make "leave it blank" read as "grant
 * nothing" in all three rows.
 */
const toolsField = textField('tools', 'Tools', 'comma-separated; empty = ALL tools')
const resourcesField = textField('resources', 'Resources', 'URI patterns or *; empty = denied')
const promptsField = textField('prompts', 'Prompts', 'patterns or *; empty = denied')

const listAction: ActionSpec = {
  id: 'list',
  title: 'list',
  minRole: 'viewer',
  command: 'agent',
  subcommand: 'list',
  fields: [],
  argv: () => ['agent', 'list'],
}

const createAction: ActionSpec = {
  id: 'create',
  title: 'create',
  minRole: ACCESS_MIN_ROLE,
  command: 'agent',
  subcommand: 'create',
  fields: [agentNameField],
  mintsToken: true,
  argv: (values) => ['agent', 'create', valueOf(values, 'name')],
  hint: 'prints the token and client config once — copy both',
}

/** `agent config --http`: the native HTTP form instead of the `connect --url` bridge. */
const httpFormField = flagField('http', 'HTTP form', 'url + Bearer header, no bridge')

/**
 * The client config block again, with `<token>` in place of the token. Not a
 * minting action — nothing secret is printed — so it earns no `token-hold`.
 */
const configAction: ActionSpec = {
  id: 'config',
  title: 'config',
  minRole: 'viewer',
  command: 'agent',
  subcommand: 'config',
  fields: [agentNameField, httpFormField],
  argv: (values) => ['agent', 'config', valueOf(values, 'name'), ...switchFlag(values, 'http', HTTP_FLAG)],
  hint: 'the client config with <token>; no admin token',
}

const grantAction: ActionSpec = {
  id: 'grant',
  title: 'grant',
  minRole: ACCESS_MIN_ROLE,
  command: 'agent',
  subcommand: 'grant',
  fields: [agentRefField, serverField, toolsField, resourcesField, promptsField],
  argv: (values) => [
    'agent',
    'grant',
    valueOf(values, 'agent'),
    valueOf(values, 'server'),
    ...optionFlag(values, 'tools', '--tools'),
    ...optionFlag(values, 'resources', '--resources'),
    ...optionFlag(values, 'prompts', '--prompts'),
  ],
  hint: 'the server must be registered first',
}

const ungrantAction: ActionSpec = {
  id: 'ungrant',
  title: 'ungrant',
  minRole: ACCESS_MIN_ROLE,
  command: 'agent',
  subcommand: 'ungrant',
  fields: [agentRefField, serverField],
  argv: (values) => ['agent', 'ungrant', valueOf(values, 'agent'), valueOf(values, 'server')],
}

const revokeAction: ActionSpec = {
  id: 'revoke',
  title: 'revoke',
  minRole: ACCESS_MIN_ROLE,
  command: 'agent',
  subcommand: 'revoke',
  fields: [agentNameField],
  argv: (values) => ['agent', 'revoke', valueOf(values, 'name')],
  confirm: (values) =>
    `Revoke agent "${valueOf(values, 'name')}"? Its token stops working at once.`,
}

/**
 * `adopt`, `adopt --apply`, `adopt --undo` (ADR-0018): put the MCP servers
 * already in Claude Code, Cursor and Claude Desktop behind `mcpcut wrap`.
 *
 * `requires: 'local'` on all three: the command edits the client config files
 * of the machine it runs on, and over `--remote` that is the plane host, not
 * the developer's laptop — so a remote console does not offer it (the same
 * reason as `Services ▸ setup`).
 *
 * `minRole` is `owner`, like `setup`, the other local action that rewrites
 * files outside the plane: the command reads no admin token, so the threshold
 * only keeps the form from being offered to a role that cannot decide what
 * runs on this machine. A one-person laptop install is its own owner.
 *
 * One flag per client (none ticked = every client) becomes a repeated
 * `--client`, the shape the CLI takes.
 */
const CLIENT_LABELS: Readonly<Record<(typeof CLIENT_IDS)[number], string>> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  'claude-desktop': 'Desktop',
}

const clientFields = CLIENT_IDS.map((id) => flagField(id, CLIENT_LABELS[id], 'only this client; none ticked = all'))

function clientFlags(values: FormValues): readonly string[] {
  return CLIENT_IDS.flatMap((id) => (isOn(values, id) ? ['--client', id] : []))
}

const adoptAction: ActionSpec = {
  id: 'adopt',
  title: 'adopt',
  minRole: 'owner',
  command: 'adopt',
  requires: 'local',
  fields: clientFields,
  argv: (values) => ['adopt', ...clientFlags(values)],
  hint: 'preview: shows the change, writes nothing',
}

const adoptApplyAction: ActionSpec = {
  id: 'adopt-apply',
  title: 'adopt --apply',
  minRole: 'owner',
  command: 'adopt',
  requires: 'local',
  fields: clientFields,
  argv: (values) => ['adopt', '--apply', ...clientFlags(values)],
  confirm: () =>
    'Rewrite the MCP server entries in the config files of Claude Code, Cursor and Claude Desktop on this machine? A copy of each file is kept; adopt --undo puts them back.',
  hint: 'writes the change; a copy of each file is kept',
}

const adoptUndoAction: ActionSpec = {
  id: 'adopt-undo',
  title: 'adopt --undo',
  minRole: 'owner',
  command: 'adopt',
  requires: 'local',
  fields: [],
  argv: () => ['adopt', '--undo'],
  confirm: () => 'Put back what the last adopt --apply changed in the client config files on this machine?',
  hint: 'reverts the last adopt --apply',
}

/** Agent identities: who may reach this plane, and what each one may reach through it. */
export const AGENTS_SECTION: SectionSpec = {
  id: 'agents',
  title: 'Agents',
  minRole: 'viewer',
  intro: [
    'Agent identities and their grants; a token is shown',
    'once, at creation.',
  ],
  actions: [
    listAction,
    createAction,
    configAction,
    grantAction,
    ungrantAction,
    revokeAction,
    adoptAction,
    adoptApplyAction,
    adoptUndoAction,
  ],
  refreshActionId: 'list',
  nextStep: {
    minRole: createAction.minRole,
    line: 'None yet? create one, then grant it a server.',
    otherwise: 'None yet? An owner creates them.',
  },
}
