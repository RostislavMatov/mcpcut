import { SECRET_NAME_PATTERN } from '../../vault/constants.js'
import type { FieldSpec } from '../form.js'
import { STDIN_SECRET_HINT } from '../constants.js'
import { patternField, secretField, valueOf } from './fields.js'
import type { ActionSpec, SectionSpec } from './types.js'

/**
 * The Vault section (mcpcut phase 4, Task 4): `vault init|set|list|remove|
 * rekey` as five declarative actions.
 *
 * Every threshold here is `owner`, mirroring the `GET /vault` row of
 * `ROUTE_TABLE` (`src/ui/authz.ts`; read, never imported from here) — the web
 * surface shows the vault to an owner and to nobody else, and the CLI gates
 * `set`, `remove` and `rekey` on an owner token (owner decision S2 of
 * 2026-09-03, amending ADR-0003). `init` and `list` are token-free in the
 * shell because `init` runs before any admin exists; the section still keeps
 * them behind the same tab, because a screen that shows two of five actions
 * to an operator is a dead end rather than a courtesy.
 *
 * The one invariant that is a security property rather than a UX one: the
 * secret NEVER appears in `argv`. `set` declares `stdinField: 'value'`, so the
 * runtime hands the typed value straight to the command's stdin reader
 * (`VaultCmdDeps.readSecretInput`) and it reaches neither the command line
 * (i.e. `ps`), nor the "equivalent command" line, nor a drawn frame. That is
 * also why `set` carries no `confirm`: a confirm pane would make the model the
 * second place the secret lives.
 *
 * IMPORT DISCIPLINE: `../../vault/constants.js` only. `src/vault/resolve` is
 * off limits to `src/tui/**` (`tests/architecture/imports.test.ts`) — the
 * console must not be able to read a secret value, only to name one.
 */

/** Secret names share the registry's lowercase DNS-label shape. */
const nameField: FieldSpec = patternField('name', 'Name', SECRET_NAME_PATTERN)

/** Masked on screen, emptied by `clearSecrets`, and never put in a command line. */
const valueField: FieldSpec = secretField('value', 'Value', STDIN_SECRET_HINT)

const listAction: ActionSpec = {
  id: 'list',
  title: 'list',
  minRole: 'owner',
  command: 'vault',
  subcommand: 'list',
  fields: [],
  argv: () => ['vault', 'list'],
}

const initAction: ActionSpec = {
  id: 'init',
  title: 'init',
  minRole: 'owner',
  command: 'vault',
  subcommand: 'init',
  fields: [],
  argv: () => ['vault', 'init'],
  hint: 'creates the master key; refused if one exists',
}

const setAction: ActionSpec = {
  id: 'set',
  title: 'set',
  minRole: 'owner',
  command: 'vault',
  subcommand: 'set',
  fields: [nameField, valueField],
  argv: (values) => ['vault', 'set', valueOf(values, 'name')],
  stdinField: 'value',
  hint: 'the value goes to the command’s stdin, never to argv',
}

const removeAction: ActionSpec = {
  id: 'remove',
  title: 'remove',
  minRole: 'owner',
  command: 'vault',
  subcommand: 'remove',
  fields: [nameField],
  argv: (values) => ['vault', 'remove', valueOf(values, 'name')],
  confirm: (values) => {
    const name = valueOf(values, 'name')
    return `Remove secret "${name}"? Servers referencing vault:${name} stop resolving it.`
  },
}

const rekeyAction: ActionSpec = {
  id: 'rekey',
  title: 'rekey',
  minRole: 'owner',
  command: 'vault',
  subcommand: 'rekey',
  fields: [],
  argv: () => ['vault', 'rekey'],
  confirm: () => 'Rotate the master key and re-encrypt every secret?',
}

/** The encrypted secrets registry records reference as `vault:<name>`. */
export const VAULT_SECTION: SectionSpec = {
  id: 'vault',
  title: 'Vault',
  minRole: 'owner',
  intro: [
    'Encrypted secrets servers reference as vault:<name>;',
    'values never leave the vault through this screen.',
  ],
  actions: [listAction, initAction, setAction, removeAction, rekeyAction],
  refreshActionId: 'list',
}
