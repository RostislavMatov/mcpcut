import { parseRetentionDuration, PRUNE_MIN_ROLE } from '../../cli/prune-cmd.js'
import type { FieldSpec } from '../form.js'
import {
  flagField,
  isOn,
  optionalSessionField,
  optionFlag,
  switchFlag,
  textField,
  valueOf,
} from './fields.js'
import type { ActionSpec, SectionSpec } from './types.js'

/**
 * The Audit section (mcpcut phase 4, Task 6): the M5 evidence commands —
 * `export --report`, `verify` in its three forms, `keygen`, `backup`,
 * `prune` and `migrate`.
 *
 * Reading evidence is `viewer` (`export --report`, `verify`, `verify
 * --report` open nothing they can change), and everything that WRITES is
 * `owner`: `--sign` appends an anchor under this installation's key,
 * `keygen` mints that key once and refuses to do it twice, `backup` copies
 * both databases, `migrate` imports legacy state, and `prune` is the only
 * command in the product that ever deletes a journal record.
 *
 * The section has NO `refreshActionId` on purpose. `r` re-runs a section's
 * reader, and Audit has none: every action here either produces a file or
 * walks the whole chain, and a key held down would sign, copy or verify
 * again rather than redraw a list.
 *
 * The three `verify*` actions share one `CommandPair` (`verify`), as do the
 * two `export*` (`export`, the other being the Journal section's) — the
 * catalogue deduplicates pairs, and one command wearing three forms is still
 * one synopsis in `USAGE`.
 *
 * `prune`'s confirmation is conditional: the form's own `--yes` flag is the
 * operator answering the question already, and asking a second time for a
 * DRY RUN — which deletes nothing — would train the reflex that dismisses
 * the real one. Its period field is validated by `parseRetentionDuration`
 * ITSELF (`src/cli/prune-cmd.ts`) rather than by a pattern that looks like
 * it: the command refuses `0d` and anything past `MAX_RETENTION_DAYS` as
 * well as `1w`, and a second grammar here would accept two of the three and
 * fail after the database had been opened.
 *
 * WHOSE THRESHOLDS THESE ARE (owner decision Q17, 2026-09-08). No route in
 * `ROUTE_TABLE` (`src/ui/authz.ts`) covers any of these commands — there is
 * no way to delete evidence or mint a key from a browser — so unlike every
 * other section these roles mirror no route. Two kinds sit here:
 *
 * - `prune` carries `PRUNE_MIN_ROLE` (`src/cli/prune-cmd.ts`), the threshold
 *   the DELETING half of the command enforces for itself. The console reads
 *   the constant rather than restating `'owner'`, so the form a viewer is
 *   shown and the answer the command gives cannot drift apart.
 * - `verify --sign`, `keygen`, `backup` and `migrate` have NO gate, by
 *   decision: each is needed before any admin exists (a fresh install has no
 *   admin store to check a token against) and from cron. Their `owner` here
 *   is console-local ergonomics — it keeps a viewer from being shown a
 *   key-minting form — and the commands stay available to anyone with a shell.
 *   What they DO record is the actor, whenever a valid `MCP_ADMIN_TOKEN` is
 *   present: the console signs an operator in, hands their token down through
 *   the `keygen`/`backup`/`migrate`/`verify` seams of `SESSION_ENV_SEAMS`, and
 *   each run leaves an `access-edit` record naming them.
 */

/** The refusal the period field prints; the grammar it names is the command's, not ours. */
const RETENTION_ERROR = 'expected e.g. 90d or 36h'

/** The retention period, ruled on by the very function `prune` will rule on it with. */
const retentionField: FieldSpec = {
  ...textField('older-than', 'Older than', 'e.g. 90d or 36h', true),
  validate: (value) =>
    parseRetentionDuration(value.trim()) === null ? RETENTION_ERROR : undefined,
}

const exportReportAction: ActionSpec = {
  id: 'export-report',
  title: 'export --report',
  minRole: 'viewer',
  command: 'export',
  fields: [
    textField('out', 'Out', 'directory; default ./mcpcut-report'),
    optionalSessionField,
  ],
  argv: (values) => [
    'export',
    '--report',
    ...optionFlag(values, 'session', '--session'),
    ...optionFlag(values, 'out', '--out'),
  ],
  hint: 'the directory must not exist, or must be empty',
}

const verifyAction: ActionSpec = {
  id: 'verify',
  title: 'verify',
  minRole: 'viewer',
  command: 'verify',
  fields: [optionalSessionField],
  argv: (values) => ['verify', ...optionFlag(values, 'session', '--session')],
  hint: 'exit 0 ok · 1 could not run · 2 chain broken',
}

const verifySignAction: ActionSpec = {
  id: 'verify-sign',
  title: 'verify --sign',
  minRole: 'owner',
  command: 'verify',
  fields: [optionalSessionField],
  argv: (values) => ['verify', '--sign', ...optionFlag(values, 'session', '--session')],
  // No gate; the actor is recorded when a token is present (Q17).
  hint: 'also signs the chain head with this installation’s key',
}

const verifyReportAction: ActionSpec = {
  id: 'verify-report',
  title: 'verify --report',
  minRole: 'viewer',
  command: 'verify',
  fields: [
    textField('dir', 'Report dir', 'the exported report directory', true),
    textField('pub', 'Public key', 'public key; default <dir>/signing.pub'),
    flagField('require-signature', 'Require sig', 'fail an unsigned export'),
  ],
  argv: (values) => [
    'verify',
    '--report',
    valueOf(values, 'dir'),
    ...optionFlag(values, 'pub', '--pub'),
    ...switchFlag(values, 'require-signature', '--require-signature'),
  ],
  hint: 'checks an export offline: no database is opened',
}

const keygenAction: ActionSpec = {
  id: 'keygen',
  title: 'keygen',
  minRole: 'owner',
  command: 'keygen',
  fields: [],
  argv: () => ['keygen'],
  // No gate; the actor is recorded when a token is present (Q17). The hint
  // says what the smoke found (Q25): on an install made by `setup` the key
  // already exists, so this action can only ever print a refusal.
  hint: 'refused if a key exists (setup makes one)',
}

const backupAction: ActionSpec = {
  id: 'backup',
  title: 'backup',
  minRole: 'owner',
  command: 'backup',
  fields: [textField('dest', 'Dest', 'directory to create; no file is replaced', true)],
  argv: (values) => ['backup', valueOf(values, 'dest')],
  // No gate; the actor is recorded when a token is present (Q17).
  hint: 'copies state.db and journal.db, consistently',
}

// The one action in this section whose role is a REAL threshold: since Q17
// the deleting half of `prune` refuses without an owner token and records the
// admin who ran it. `PRUNE_MIN_ROLE` is that threshold, imported rather than
// restated.
const pruneAction: ActionSpec = {
  id: 'prune',
  title: 'prune',
  minRole: PRUNE_MIN_ROLE,
  command: 'prune',
  fields: [
    retentionField,
    flagField('yes', 'Delete', 'off = dry run: what it would delete'),
  ],
  argv: (values) => [
    'prune',
    '--older-than',
    valueOf(values, 'older-than'),
    ...switchFlag(values, 'yes', '--yes'),
  ],
  confirm: (values) =>
    isOn(values, 'yes')
      ? `Delete journal records older than ${valueOf(values, 'older-than')}? ` +
        'This is the only thing that ever deletes evidence.'
      : undefined,
}

const migrateAction: ActionSpec = {
  id: 'migrate',
  title: 'migrate',
  minRole: 'owner',
  command: 'migrate',
  fields: [],
  argv: () => ['migrate'],
  // No gate; the actor is recorded when a token is present (Q17).
  hint: 'imports legacy *.json/*.jsonl state into the databases',
}

/** Evidence: what an auditor is handed, and what keeps it checkable. */
export const AUDIT_SECTION: SectionSpec = {
  id: 'audit',
  title: 'Audit',
  minRole: 'viewer',
  intro: [
    'Evidence: reports, the hash chain, the signing key,',
    'backups, retention.',
  ],
  actions: [
    exportReportAction,
    verifyAction,
    verifySignAction,
    verifyReportAction,
    keygenAction,
    backupAction,
    pruneAction,
    migrateAction,
  ],
}
