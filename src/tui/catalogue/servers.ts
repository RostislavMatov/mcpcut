import { SERVER_REFRESH_MIN_ROLE } from '../../cli/server-status-cmd.js'
import {
  HTTP_PROTOCOL_VALUES,
  REGISTRY_SERVER_NAME_PATTERN,
  SERVER_TRANSPORT_VALUES,
} from '../../registry/constants.js'
import type { FieldSpec } from '../form.js'
import {
  choiceFlag,
  flagField,
  optionFlag,
  optionalChoice,
  patternField,
  repeatedFlag,
  switchFlag,
  textField,
  valueOf,
} from './fields.js'
import type { ActionSpec, SectionSpec } from './types.js'

/**
 * The Servers section (mcpcut phase 4, Task 4): `server list|show|add|refresh|
 * remove` as five declarative actions.
 *
 * Whose threshold each `minRole` mirrors:
 * - `list`, `show` — `viewer`, the `GET /servers` row of `ROUTE_TABLE`
 *   (`src/ui/authz.ts`; read, never imported from here).
 * - `add` — `owner`, the `POST /servers/add` row.
 * - `refresh` — `SERVER_REFRESH_MIN_ROLE`, imported from the command itself
 *   rather than restated, because that constant is already the mirror of
 *   `POST /servers/refresh` and a second copy is a second answer.
 * - `remove` — `owner`, the `POST /servers/remove` row.
 *
 * A threshold here only keeps the screen free of dead ends. The real answer is
 * given one layer down: `server refresh`, `add` and `remove` re-check the
 * personal admin token the console passes through the environment seam, and
 * every mutation leaves a journal record naming the admin who made it.
 *
 * No second opinion on the arguments: the form validates only the server name,
 * with the registry's own pattern. Whether `--url` belongs on a stdio record,
 * whether an `--env` value is a usable `vault:` reference, whether the name is
 * already taken — all of that is the command's to refuse, in its own words,
 * shown in the output pane.
 */

/** Registry names are the narrow lowercase DNS-label style the store enforces. */
const nameField: FieldSpec = patternField('name', 'Name', REGISTRY_SERVER_NAME_PATTERN)

/** The two transports, as a closed choice: a typo cannot reach the CLI. */
const transportField: FieldSpec = {
  name: 'transport',
  label: 'Transport',
  kind: 'choice',
  options: SERVER_TRANSPORT_VALUES,
}

const commandField = textField('command', 'Command', 'stdio: the executable')
const argsField = textField('args', 'Args', 'stdio: comma-separated')
/**
 * The Env field names `HTTPS_PROXY` because the plane deliberately drops it.
 *
 * `SYSTEM_ENV_ALLOWLIST` (`src/config.ts`) is what a spawned stdio child
 * inherits, and the proxy variables are not on it. Behind a proxy an
 * `npx -y …` server therefore never reaches the network and the probe fails
 * with `no answer to initialize within 10000ms` — a truthful message that
 * gives the operator no thread to pull (owner tail Q26, found in the phase-4
 * smoke). Naming the variable in the hint is the thread.
 *
 * What the 40-character line no longer has room to say: an `--env` VALUE may
 * not contain a comma, because the console splits this field on commas.
 */
const envField = textField('env', 'Env', 'stdio: K=V,…; HTTPS_PROXY if behind one')
const urlField = textField('url', 'URL', 'http: the endpoint URL')
const headerField = textField('header', 'Header', 'http: K=V,... (values may be vault:name)')
const protocolField = optionalChoice('protocol', 'Protocol', HTTP_PROTOCOL_VALUES, 'http')

const pruneGrantsField = flagField('prune-grants', 'Prune', 'prune grants behind an UNKNOWN name')

const listAction: ActionSpec = {
  id: 'list',
  title: 'list',
  minRole: 'viewer',
  command: 'server',
  subcommand: 'list',
  fields: [],
  argv: () => ['server', 'list'],
}

const showAction: ActionSpec = {
  id: 'show',
  title: 'show',
  minRole: 'viewer',
  command: 'server',
  subcommand: 'show',
  fields: [nameField],
  argv: (values) => ['server', 'show', valueOf(values, 'name')],
}

const addAction: ActionSpec = {
  id: 'add',
  title: 'add',
  minRole: 'owner',
  command: 'server',
  subcommand: 'add',
  fields: [
    nameField,
    transportField,
    commandField,
    argsField,
    envField,
    urlField,
    headerField,
    protocolField,
  ],
  argv: (values) => [
    'server',
    'add',
    valueOf(values, 'name'),
    '--transport',
    valueOf(values, 'transport'),
    ...optionFlag(values, 'command', '--command'),
    ...optionFlag(values, 'args', '--args'),
    ...repeatedFlag(values, 'env', '--env'),
    ...optionFlag(values, 'url', '--url'),
    ...repeatedFlag(values, 'header', '--header'),
    ...choiceFlag(values, 'protocol', '--protocol'),
  ],
  hint: 'probes once; behind a proxy add HTTPS_PROXY to Env',
}

const refreshAction: ActionSpec = {
  id: 'refresh',
  title: 'refresh',
  minRole: SERVER_REFRESH_MIN_ROLE,
  command: 'server',
  subcommand: 'refresh',
  fields: [nameField],
  argv: (values) => ['server', 'refresh', valueOf(values, 'name')],
}

const removeAction: ActionSpec = {
  id: 'remove',
  title: 'remove',
  minRole: 'owner',
  command: 'server',
  subcommand: 'remove',
  fields: [nameField, pruneGrantsField],
  argv: (values) => [
    'server',
    'remove',
    valueOf(values, 'name'),
    ...switchFlag(values, 'prune-grants', '--prune-grants'),
  ],
  confirm: (values) =>
    `Remove server "${valueOf(values, 'name')}"? Its grants are dropped from every agent and group.`,
}

/** The MCP servers this installation knows how to reach. */
export const SERVERS_SECTION: SectionSpec = {
  id: 'servers',
  title: 'Servers',
  minRole: 'viewer',
  intro: ['MCP servers the plane can reach; list and show', 'probe the stale ones.'],
  actions: [listAction, showAction, addAction, refreshAction, removeAction],
  refreshActionId: 'list',
}
