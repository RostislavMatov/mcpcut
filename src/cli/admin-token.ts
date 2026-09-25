import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { roleSatisfies, type Role } from '../admin/authz.js'
import { ADMIN_TOKEN_ENV_VAR } from '../admin/constants.js'
import { createAdminStore } from '../admin/store.js'
import { JOURNAL_DIR } from '../config.js'
import { STATE_DB_FILE_NAME } from '../policy/store-backend.js'
import { formatReadableField } from '../journal/format.js'
import { isExpectedAdminError } from './admin-cmd.js'

/**
 * `MCP_ADMIN_TOKEN` → named admin, shared by every CLI command that must
 * attribute an action to a human (`server refresh`, `policy set`; the
 * `approvals approve|deny` pattern this generalizes). Resolving buys
 * ATTRIBUTION and role parity with the admin UI, not an access barrier — a
 * process under the same uid can read the environment anyway (ADR-0004).
 *
 * Never throws for an expected store fault: an unreadable admin store is a
 * refusal the caller can print, never a crash and never an unattributed
 * action (fail closed).
 */

export interface AdminTokenOptions {
  /** Journal directory holding the admin store. Defaults to `JOURNAL_DIR`. */
  readonly journalDir?: string
  /** Environment to read `MCP_ADMIN_TOKEN` from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
}

export type TokenAdmin =
  | { readonly kind: 'ok'; readonly name: string; readonly role: Role }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'unreadable'; readonly detail: string }

/** Resolves `MCP_ADMIN_TOKEN` to a named admin; never throws for expected store faults. */
export async function adminFromEnv(opts: AdminTokenOptions): Promise<TokenAdmin> {
  const env = opts.env ?? process.env
  const token = env[ADMIN_TOKEN_ENV_VAR]
  if (token === undefined || token === '') {
    return { kind: 'missing' }
  }
  const store = createAdminStore(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {})
  try {
    const admin = await store.findAdminByToken(token)
    return admin === undefined ? { kind: 'unknown' } : { kind: 'ok', name: admin.name, role: admin.role }
  } catch (error: unknown) {
    if (!isExpectedAdminError(error)) throw error
    return { kind: 'unreadable', detail: error.message }
  }
}

/**
 * Wording of the four refusals, so one shared resolver can speak in each
 * command's own terms. `policy set` phrased these first; the fields keep its
 * lines byte-identical while `group *` says "change groups" in the same
 * places (its tests pin both).
 */
export interface AdminRefusalWording {
  /** Completes "Refusing to ...": the action being refused, e.g. `edit the policy`. */
  readonly action: string
  /** Names the change in "so the <noun> records which admin made it". */
  readonly noun: string
  /** Completes "this admin token's role ...", e.g. `may not change rules`. */
  readonly verb: string
  /** Extra clause inside the role parenthesis, after `role "owner" is required`. */
  readonly roleDetail?: string
  /**
   * Why the token is needed, when it is not "so the <noun> records which admin
   * made it" — a read that is limited to a role rather than a change that is
   * attributed to a person.
   */
  readonly purpose?: string
}

/** Minimal stderr shape the refusals are written to (tests inject a capture object). */
export interface AdminTokenErrorIo {
  readonly stderr: { write(chunk: string): unknown }
}

/** The admin behind `MCP_ADMIN_TOKEN`, once resolved and role-checked. */
export interface RequiredAdmin {
  readonly adminName: string
  readonly role: Role
}

function missingTokenMessage(minRole: Role, wording: AdminRefusalWording): string {
  return (
    `Refusing to ${wording.action}: no admin token. Set ${ADMIN_TOKEN_ENV_VAR} to your personal admin token ` +
    `(role "${minRole}") ${wording.purpose ?? `so the ${wording.noun} records which admin made it`}.\n` +
    `Get one with: mcpcut admin add <name> --role ${minRole}   (existing admin: mcpcut admin rotate <name>)\n`
  )
}

function unknownTokenMessage(wording: AdminRefusalWording): string {
  return (
    `Refusing to ${wording.action}: ${ADMIN_TOKEN_ENV_VAR} does not match any active admin — it may have been ` +
    `rotated, or the admin removed.\n` +
    `Check "mcpcut admin list", then: mcpcut admin rotate <name>\n`
  )
}

function unreadableStoreMessage(detail: string, wording: AdminRefusalWording): string {
  return (
    `Refusing to ${wording.action}: the admin store could not be read, so the ${wording.noun} could not be ` +
    `attributed to a human.\n${formatReadableField(detail)}\n` +
    `Check the file named above, then: mcpcut admin list\n`
  )
}

function insufficientRoleMessage(
  adminName: string,
  minRole: Role,
  wording: AdminRefusalWording,
): string {
  const detail = wording.roleDetail === undefined ? '' : `, ${wording.roleDetail}`
  return (
    `Refusing to ${wording.action}: this admin token's role ${wording.verb} ` +
    `(role "${minRole}" is required${detail}).\n` +
    `An owner can change it with: mcpcut admin role ${formatReadableField(adminName)} ${minRole}\n`
  )
}

/**
 * The three ways an OPTIONAL token resolves: nobody was named, somebody was,
 * or a token was supplied that this installation cannot place.
 */
export type OptionalAdmin =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'admin'; readonly admin: RequiredAdmin }

/**
 * The named admin behind `MCP_ADMIN_TOKEN` when there IS one, for the host
 * operations that must keep working with none (owner decision Q17,
 * 2026-09-08: `keygen`, `backup`, `migrate`, `verify --sign` run before any
 * admin exists and from cron).
 *
 * No role is checked — these commands are not gated; the token buys a name on
 * the record and nothing else. But a token that resolves to nobody is
 * REFUSED, with the refusal already printed: silently running anonymously
 * would hide a rotated or mistyped token behind a successful command, which is
 * exactly the mistake an operator wants to hear about.
 */
export async function optionalAdminFromEnv(
  opts: AdminTokenOptions,
  io: AdminTokenErrorIo,
  wording: AdminRefusalWording,
): Promise<OptionalAdmin> {
  const resolved = await adminFromEnv(opts)
  if (resolved.kind === 'missing') return { kind: 'anonymous' }
  if (resolved.kind === 'unknown') {
    io.stderr.write(unknownTokenMessage(wording))
    return { kind: 'refused' }
  }
  if (resolved.kind === 'unreadable') {
    io.stderr.write(unreadableStoreMessage(resolved.detail, wording))
    return { kind: 'refused' }
  }
  return { kind: 'admin', admin: { adminName: resolved.name, role: resolved.role } }
}

/**
 * The named admin behind `MCP_ADMIN_TOKEN` when it satisfies `minRole`, or
 * `undefined` with the refusal ALREADY printed to `io.stderr` — the caller
 * just returns exit 1. Every write-side CLI that must be attributable shares
 * this one gate, so the UI's role table cannot be stepped around from a shell
 * (ADR-0004 lesson, ADR-0009 O6).
 *
 * Fails closed on every branch: no token, an unknown token, an unreadable
 * admin store and too low a role all refuse, and none of them throws.
 */
export async function requireAdminFromEnv(
  opts: AdminTokenOptions,
  minRole: Role,
  io: AdminTokenErrorIo,
  wording: AdminRefusalWording,
): Promise<RequiredAdmin | undefined> {
  return admitResolved(await adminFromEnv(opts), minRole, io, wording)
}

/** The shared tail of both gates: every `TokenAdmin` either admits a named admin or prints its refusal. */
function admitResolved(
  resolved: TokenAdmin,
  minRole: Role,
  io: AdminTokenErrorIo,
  wording: AdminRefusalWording,
): RequiredAdmin | undefined {
  if (resolved.kind === 'missing') {
    io.stderr.write(missingTokenMessage(minRole, wording))
    return undefined
  }
  if (resolved.kind === 'unknown') {
    io.stderr.write(unknownTokenMessage(wording))
    return undefined
  }
  if (resolved.kind === 'unreadable') {
    io.stderr.write(unreadableStoreMessage(resolved.detail, wording))
    return undefined
  }
  if (!roleSatisfies(resolved.role, minRole)) {
    io.stderr.write(insufficientRoleMessage(resolved.name, minRole, wording))
    return undefined
  }
  return { adminName: resolved.name, role: resolved.role }
}

/**
 * The `actor` of an approval resolved from a shell while NO admin exists
 * (owner decision 2026-09-25). A subject is still recorded (ADR-0007 O3), and
 * `_` lies outside `ADMIN_NAME_PATTERN`, so no admin can ever spell it.
 */
export const NO_ADMINS_YET_ACTOR = 'cli:_unattributed'

/** Said once per action taken without a name because no name can exist yet. */
export const NO_ADMINS_YET_NOTICE =
  'note: no admins yet, so this is recorded without a name; ' +
  'after the first "mcpcut admin add" a token is required\n'

/**
 * Whether the admin store holds no admin at all — `unreadable` when that
 * cannot be told, `no-install` when the data directory has never held one.
 */
export type AdminStoreEmptiness =
  | { readonly kind: 'empty' }
  | { readonly kind: 'populated' }
  | { readonly kind: 'no-install' }
  | { readonly kind: 'unreadable'; readonly detail: string }

/**
 * The same question the token-free first `admin add` asks (`admin-cmd.ts`,
 * `addActor`): is this install still before its first admin? A store that
 * cannot be read answers `unreadable`, never `empty` — "cannot tell whether
 * anyone exists" must not open what "nobody exists" opens.
 *
 * A data directory without `state.db` answers `no-install`, checked BEFORE
 * the store is opened (opening creates it). That is a cron job or a unit file
 * missing `MCPCUT_DATA_DIR`, not a fresh install — and `policy set` can still
 * reach a real policy file through `MCPCUT_POLICY` or the project file
 * (security review H1, 2026-09-25). Anything that ran through the plane has a
 * `state.db`, so the first minute is unaffected.
 */
export async function adminStoreEmptiness(opts: AdminTokenOptions): Promise<AdminStoreEmptiness> {
  if (!existsSync(join(opts.journalDir ?? JOURNAL_DIR, STATE_DB_FILE_NAME))) return { kind: 'no-install' }
  const store = createAdminStore(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {})
  try {
    return (await store.listAdmins()).length === 0 ? { kind: 'empty' } : { kind: 'populated' }
  } catch (error: unknown) {
    if (!isExpectedAdminError(error)) throw error
    return { kind: 'unreadable', detail: error.message }
  }
}

/** A named admin, or nobody because the install has no admin yet. */
export type AdminUnlessNone = { readonly kind: 'admin'; readonly admin: RequiredAdmin } | { readonly kind: 'no-admins-yet' }

/**
 * `requireAdminFromEnv`, except that with NO token on an install with NO
 * admin the action goes ahead unattributed, with `NO_ADMINS_YET_NOTICE` on
 * stderr (owner decision 2026-09-25, first-minute friction). That grants
 * nothing new: the first `admin add` there is token-free already (ADR-0004).
 * A token that IS set is checked as always — a stale one on an empty store is
 * refused, not quietly ignored — and an unreadable store refuses.
 */
export async function requireAdminUnlessNone(
  opts: AdminTokenOptions,
  minRole: Role,
  io: AdminTokenErrorIo,
  wording: AdminRefusalWording,
): Promise<AdminUnlessNone | undefined> {
  const resolved = await adminFromEnv(opts)
  if (resolved.kind === 'missing') {
    const emptiness = await adminStoreEmptiness(opts)
    if (emptiness.kind === 'empty') {
      io.stderr.write(NO_ADMINS_YET_NOTICE)
      return { kind: 'no-admins-yet' }
    }
    if (emptiness.kind === 'unreadable') {
      io.stderr.write(unreadableStoreMessage(emptiness.detail, wording))
      return undefined
    }
  }
  const admin = admitResolved(resolved, minRole, io, wording)
  return admin === undefined ? undefined : { kind: 'admin', admin }
}
