import { ADMIN_NAME_PATTERN, ADMIN_ROLES } from '../../admin/constants.js'
import type { FieldSpec, FormValues } from '../form.js'
import type { ActionSpec, SectionSpec } from './types.js'

/**
 * The Admins section (mcpcut phase 2, Task 6): `admin list|add|rotate|role|
 * remove` as five declarative actions.
 *
 * The threshold is `owner` for the section and for every action in it, which
 * is exactly what `ROUTE_TABLE` says of the equivalent web surface
 * (`GET /admins` and every `POST /admins/*` → owner). Mirroring it rather
 * than inventing a second answer is the point: two surfaces onto the same
 * store must not disagree about who may edit an identity.
 *
 * What the threshold buys is a screen without dead ends — an operator who
 * could not use these actions is not shown the tab. The real answer is given
 * one layer down: since the owner decision of 2026-09-06 every `admin`
 * subcommand re-checks the session token the console passes through the
 * `admin` environment seam (`src/tui/session-env.ts`), and every mutation
 * leaves an `access-edit` journal record naming the admin who made it. What
 * that token buys is still ATTRIBUTION rather than authority (ADR-0004): a
 * process under the same uid edits `admins.json` directly either way.
 */

/**
 * One field's value. A form always carries every field it declared, so the
 * fallback is unreachable — it is here because an index into a `Record` is
 * `string | undefined` under `noUncheckedIndexedAccess`, and an empty string
 * is what the CLI would refuse anyway.
 */
function valueOf(values: FormValues, name: string): string {
  return values[name] ?? ''
}

/** Admin names are the narrow lowercase DNS-label style the store enforces. */
const nameField: FieldSpec = {
  name: 'name',
  label: 'Name',
  kind: 'text',
  required: true,
  hint: ADMIN_NAME_PATTERN.source,
  validate: (value) =>
    ADMIN_NAME_PATTERN.test(value) ? undefined : `must match ${ADMIN_NAME_PATTERN.source}`,
}

/** The three fixed roles, as a closed choice: a typo cannot reach the CLI. */
const roleField: FieldSpec = {
  name: 'role',
  label: 'Role',
  kind: 'choice',
  options: ADMIN_ROLES,
}

const listAction: ActionSpec = {
  id: 'list',
  title: 'list',
  minRole: 'owner',
  command: 'admin',
  subcommand: 'list',
  fields: [],
  argv: () => ['admin', 'list'],
}

const addAction: ActionSpec = {
  id: 'add',
  title: 'add',
  minRole: 'owner',
  command: 'admin',
  subcommand: 'add',
  fields: [nameField, roleField],
  argv: (values) => ['admin', 'add', valueOf(values, 'name'), '--role', valueOf(values, 'role')],
  hint: 'prints the admin’s token once — copy it before leaving',
}

const rotateAction: ActionSpec = {
  id: 'rotate',
  title: 'rotate',
  minRole: 'owner',
  command: 'admin',
  subcommand: 'rotate',
  fields: [nameField],
  argv: (values) => ['admin', 'rotate', valueOf(values, 'name')],
  confirm: (values) =>
    `Rotate the token of "${valueOf(values, 'name')}"? The old token stops working and its browser sessions end.`,
}

const roleAction: ActionSpec = {
  id: 'role',
  title: 'role',
  minRole: 'owner',
  command: 'admin',
  subcommand: 'role',
  fields: [nameField, roleField],
  argv: (values) => ['admin', 'role', valueOf(values, 'name'), valueOf(values, 'role')],
}

const removeAction: ActionSpec = {
  id: 'remove',
  title: 'remove',
  minRole: 'owner',
  command: 'admin',
  subcommand: 'remove',
  fields: [nameField],
  argv: (values) => ['admin', 'remove', valueOf(values, 'name')],
  confirm: (values) => `Remove admin "${valueOf(values, 'name')}"? (the last owner cannot be removed)`,
}

/** Named admins: who may sign in to this console and to the web UI. */
export const ADMINS_SECTION: SectionSpec = {
  id: 'admins',
  title: 'Admins',
  minRole: 'owner',
  intro: [
    'Named admins of this installation: each one carries',
    'a personal token, and every decision they make is',
    'recorded under their name.',
  ],
  actions: [listAction, addAction, rotateAction, roleAction, removeAction],
  refreshActionId: 'list',
}
