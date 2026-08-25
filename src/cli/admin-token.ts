import type { Role } from '../admin/authz.js'
import { ADMIN_TOKEN_ENV_VAR } from '../admin/constants.js'
import { createAdminStore } from '../admin/store.js'
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
