import { QUARANTINE_RESOLVE_MIN_ROLE } from '../../admin/authz.js'
import type { FieldSpec } from '../form.js'
import { textField, valueOf } from './fields.js'
import type { ActionSpec, SectionSpec } from './types.js'

/**
 * The Quarantine section (mcpcut phase 4, Task 4): `quarantine list|show|
 * approve|approve --all|reject` as five declarative actions.
 *
 * Whose threshold each `minRole` mirrors (`ROUTE_TABLE`, `src/ui/authz.ts`;
 * read, never imported from here):
 * - `list`, `show` — `viewer`, the `GET /quarantine` row. Reading a schema
 *   diff decides nothing.
 * - `approve`, `approve --all`, `reject` — `QUARANTINE_RESOLVE_MIN_ROLE`
 *   (`operator`), the constant the `POST /quarantine/approve` and
 *   `POST /quarantine/reject` rows carry too. Letting a tool out of quarantine
 *   widens what an agent can reach, which is an operator decision on both
 *   surfaces.
 *
 * These are REAL thresholds, not menu filtering. Owner decision Q17
 * (2026-09-08) put the same gate on the command itself: `quarantine
 * approve|reject` resolves `MCP_ADMIN_TOKEN` against the same constant before
 * it touches the inventory, and records the release as an `access-edit`
 * naming the admin, the server and the tool. The console hands the signed-in
 * operator's token down through the `quarantine` seam of
 * `SESSION_ENV_SEAMS`, so what it shows and what the command allows are one
 * answer — and, as everywhere else, the token buys attribution and parity
 * rather than protection from a process under the same uid (ADR-0004).
 *
 * Neither name is validated here. A quarantined entry is named by whatever the
 * upstream server called it, and the CLI answers "not quarantined for server
 * X" for anything it does not hold — a second pattern in the form would only
 * be able to refuse names that legitimately exist.
 *
 * `approve --all` is its own action rather than a flag on `approve`, so the
 * pane prints one true command line per action, and so the confirm question
 * can name the whole backlog it is about to clear.
 */

const serverField: FieldSpec = textField('server', 'Server', undefined, true)
const toolField: FieldSpec = textField('tool', 'Tool', undefined, true)

const listAction: ActionSpec = {
  id: 'list',
  title: 'list',
  minRole: 'viewer',
  command: 'quarantine',
  subcommand: 'list',
  fields: [],
  argv: () => ['quarantine', 'list'],
}

const showAction: ActionSpec = {
  id: 'show',
  title: 'show',
  minRole: 'viewer',
  command: 'quarantine',
  subcommand: 'show',
  fields: [serverField, toolField],
  argv: (values) => ['quarantine', 'show', valueOf(values, 'server'), valueOf(values, 'tool')],
}

const approveAction: ActionSpec = {
  id: 'approve',
  title: 'approve',
  minRole: QUARANTINE_RESOLVE_MIN_ROLE,
  command: 'quarantine',
  subcommand: 'approve',
  fields: [serverField, toolField],
  argv: (values) => ['quarantine', 'approve', valueOf(values, 'server'), valueOf(values, 'tool')],
}

const approveAllAction: ActionSpec = {
  id: 'approve-all',
  title: 'approve --all',
  minRole: QUARANTINE_RESOLVE_MIN_ROLE,
  command: 'quarantine',
  subcommand: 'approve',
  fields: [serverField],
  argv: (values) => ['quarantine', 'approve', '--all', '--server', valueOf(values, 'server')],
  confirm: (values) => `Approve every quarantined tool of "${valueOf(values, 'server')}"?`,
}

const rejectAction: ActionSpec = {
  id: 'reject',
  title: 'reject',
  minRole: QUARANTINE_RESOLVE_MIN_ROLE,
  command: 'quarantine',
  subcommand: 'reject',
  fields: [serverField, toolField],
  argv: (values) => ['quarantine', 'reject', valueOf(values, 'server'), valueOf(values, 'tool')],
  confirm: (values) =>
    `Reject "${valueOf(values, 'tool')}" of "${valueOf(values, 'server')}"? ` +
    'The tool is discarded from the inventory.',
}

/** Tools held back until a human has looked at what changed. */
export const QUARANTINE_SECTION: SectionSpec = {
  id: 'quarantine',
  title: 'Quarantine',
  minRole: 'viewer',
  intro: [
    'Tools that are new or whose schema changed since',
    'approval; nothing here is exposed until approved.',
  ],
  actions: [listAction, showAction, approveAction, approveAllAction, rejectAction],
  refreshActionId: 'list',
}
