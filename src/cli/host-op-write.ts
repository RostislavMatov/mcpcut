import type { AccessEditAction } from '../journal/access-edit-record.js'
import { recordAccessChange, type AccessOp, type AccessWriteOptions } from './access-cmd-write.js'
import {
  optionalAdminFromEnv,
  type AdminRefusalWording,
  type OptionalAdmin,
  type RequiredAdmin,
} from './admin-token.js'

/**
 * The write path of the four HOST operations — `keygen`, `backup`, `migrate`
 * and `verify --sign` (owner decision Q17, 2026-09-08).
 *
 * These are deliberately NOT gated. Each is needed before any admin exists —
 * a fresh install has no admin store for a token to resolve against, and
 * `setup` mints the signing key on a directory that has none — and each is
 * run from cron, where nobody is at a keyboard. A gate would have made the
 * first install impossible and the nightly backup a manual chore.
 *
 * What they gained instead is ATTRIBUTION when it is available: with a valid
 * `MCP_ADMIN_TOKEN` in the environment each writes the same `access-edit`
 * record every other attributed change writes, naming the admin and the one
 * fact worth keeping. With no token they behave exactly as before, exit code
 * included, and record nothing — "nobody was named" stays a fact rather than
 * becoming an invented one.
 *
 * An INVALID token is refused, not ignored: a rotated or mistyped token
 * hidden behind a successful command is precisely the mistake an operator
 * wants to hear about (`optionalAdminFromEnv`).
 */

/** The seams every host operation shares: where the stores live, and the environment. */
export interface HostOpOptions {
  /** Directory holding `state.db` and `journal.db`. Defaults to `JOURNAL_DIR`. */
  readonly journalDir?: string
  /** Environment holding `MCP_ADMIN_TOKEN`. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
}

/** Minimal stderr shape the refusal and the audit line are written to. */
export interface HostOpIo {
  readonly stderr: { write(chunk: string): unknown }
}

/** The host operation's options in the shared write path's terms. */
export function hostOpWriteOptionsOf(opts: HostOpOptions): AccessWriteOptions {
  return {
    ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  }
}

/**
 * Who is running this host operation, if anybody. Called FIRST, before the
 * command does its work: an unusable token must not be discovered after a key
 * has been minted or a database copied.
 */
export async function resolveHostOpActor(
  io: HostOpIo,
  opts: HostOpOptions,
  wording: AdminRefusalWording,
): Promise<OptionalAdmin> {
  return optionalAdminFromEnv(hostOpWriteOptionsOf(opts), io, wording)
}

/** What one host operation's record says beyond its actor. */
export interface HostOpRecord {
  /** The audit line's verb, e.g. `backup`. */
  readonly op: AccessOp
  /** The record's action, e.g. `verify.sign`. */
  readonly action: AccessEditAction
  /** The audit line's subject, already safe for a terminal. */
  readonly target: string
  /** `backup` only: the directory the databases were copied into. */
  readonly dest?: string
  /** `keygen` / `verify.sign` only: the public fingerprint of the key involved. */
  readonly keyFingerprint?: string
}

/**
 * The audit line plus the `access-edit` record of one completed host
 * operation, when an admin was named. A `null` actor — the ordinary
 * unattended run — writes nothing at all and leaves the exit code alone,
 * which is why this returns `void` rather than a code: unlike the gated
 * commands, the record is never what the command's success depends on.
 */
export async function recordHostOp(
  io: HostOpIo,
  opts: HostOpOptions,
  actor: RequiredAdmin | null,
  record: HostOpRecord,
): Promise<void> {
  if (actor === null) return
  await recordAccessChange({
    io,
    opts: hostOpWriteOptionsOf(opts),
    actor,
    subject: 'host',
    op: record.op,
    target: record.target,
    info: {
      action: record.action,
      ...(record.dest !== undefined ? { dest: record.dest } : {}),
      ...(record.keyFingerprint !== undefined ? { keyFingerprint: record.keyFingerprint } : {}),
    },
  })
}

/** The admin an `OptionalAdmin` names, or `null` when nobody was named. */
export function adminOf(resolved: OptionalAdmin): RequiredAdmin | null {
  return resolved.kind === 'admin' ? resolved.admin : null
}
