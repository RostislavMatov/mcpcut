import { roleSatisfies, type Role } from '../admin/authz.js'
import { ADMIN_TOKEN_ENV_VAR } from '../admin/constants.js'
import { createAdminStore } from '../admin/store.js'
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
    `Get one with: mcp-journal admin add <name> --role ${minRole}   (existing admin: mcp-journal admin rotate <name>)\n`
  )
}

function unknownTokenMessage(wording: AdminRefusalWording): string {
  return (
    `Refusing to ${wording.action}: ${ADMIN_TOKEN_ENV_VAR} does not match any active admin — it may have been ` +
    `rotated, or the admin removed.\n` +
    `Check "mcp-journal admin list", then: mcp-journal admin rotate <name>\n`
  )
}

function unreadableStoreMessage(detail: string, wording: AdminRefusalWording): string {
  return (
    `Refusing to ${wording.action}: the admin store could not be read, so the ${wording.noun} could not be ` +
    `attributed to a human.\n${formatReadableField(detail)}\n` +
    `Check the file named above, then: mcp-journal admin list\n`
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
    `An owner can change it with: mcp-journal admin role ${formatReadableField(adminName)} ${minRole}\n`
  )
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
  const resolved = await adminFromEnv(opts)
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
