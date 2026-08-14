import { join } from 'node:path'
import { z } from 'zod'
import { JOURNAL_DIR } from '../config.js'
import { RESERVED_OBJECT_KEYS } from '../policy/constants.js'
import { createJsonStore, type JsonStore } from '../policy/store.js'
import { generateToken, verifyToken } from '../security/token.js'
import {
  ADMIN_NAME_PATTERN,
  ADMIN_ROLES,
  ADMIN_TOKEN_HASH_PATTERN,
  ADMIN_TOKEN_PREFIX,
  ADMIN_TOKEN_RANDOM_BYTES,
  ADMINS_FILE_NAME,
  isAdminRole,
  MAX_ADMINS,
  type AdminRole,
} from './constants.js'

/**
 * CLI/UI-managed store for named admin identities, backed by
 * `<journalDir>/admins.json` via `createJsonStore` (atomic tmp+rename,
 * cross-process lock, 0600/0700 — the same trust level as the journal and the
 * agents store). Only token HASHES are ever persisted; the plaintext token
 * exists once, in the return value of `createAdmin`/`rotateAdmin`, printed by
 * the CLI exactly once (ADR-0004, Decision 3).
 *
 * The crypto (`generateToken`/`verifyToken`, `timingSafeEqual`) is shared with
 * agents through `src/security/token.ts` — this module never re-implements it.
 */

// ---------------------------------------------------------------------------
// Schema (this file is a trust boundary: a hand-edited or corrupt admins file
// must fail LOUDLY via StoreCorruptError, never degrade to "no admins")
// ---------------------------------------------------------------------------

const adminNameSchema = z
  .string()
  .regex(ADMIN_NAME_PATTERN, 'admin name must match ^[a-z0-9][a-z0-9-]{0,63}$')

const adminRecordSchema = z.strictObject({
  name: adminNameSchema,
  role: z.enum(ADMIN_ROLES),
  tokenHash: z.string().regex(ADMIN_TOKEN_HASH_PATTERN, 'tokenHash must be a sha256 hex digest'),
  createdAt: z.iso.datetime(),
  rotatedAt: z.iso.datetime().optional(),
  revokedAt: z.iso.datetime().optional(),
})

/** One admin: a named human identity with a fixed role (hash only, never a plaintext token). */
export type AdminRecord = z.infer<typeof adminRecordSchema>

const adminsFileSchema = z.strictObject({
  version: z.literal(1),
  admins: z
    .record(adminNameSchema, adminRecordSchema)
    .refine((map) => Object.keys(map).length <= MAX_ADMINS, {
      message: `too many admins: max ${MAX_ADMINS}`,
    })
    .superRefine((map, ctx) => {
      for (const key of Object.getOwnPropertyNames(map)) {
        if (RESERVED_OBJECT_KEYS.includes(key)) {
          ctx.addIssue({ code: 'custom', message: `reserved key "${key}" is not allowed`, path: [key] })
          continue
        }
        const record = map[key]
        if (record !== undefined && record.name !== key) {
          ctx.addIssue({
            code: 'custom',
            message: `admins key "${key}" does not match record name "${record.name}"`,
            path: [key, 'name'],
          })
        }
      }
    }),
})

/** The whole `admins.json` document. */
export type AdminsFile = z.infer<typeof adminsFileSchema>

const EMPTY_FILE: AdminsFile = { version: 1, admins: {} }

// ---------------------------------------------------------------------------
// Errors (union-friendly named types so callers can branch without string-matching)
// ---------------------------------------------------------------------------

/** Raised when creating an admin whose name is already taken by a live record. */
export class AdminExistsError extends Error {
  constructor(name: string) {
    super(`admin "${name}" already exists`)
    this.name = 'AdminExistsError'
  }
}

/** Raised when an operation targets an admin that does not exist (or is revoked). */
export class AdminNotFoundError extends Error {
  constructor(name: string) {
    super(`admin "${name}" does not exist`)
    this.name = 'AdminNotFoundError'
  }
}

/** Raised for an admin name outside `^[a-z0-9][a-z0-9-]{0,63}$` (or a reserved word). */
export class InvalidAdminNameError extends Error {
  constructor(name: string) {
    super(`invalid admin name "${name}": must match ^[a-z0-9][a-z0-9-]{0,63}$`)
    this.name = 'InvalidAdminNameError'
  }
}

/** Raised for a role outside the three fixed values. */
export class InvalidAdminRoleError extends Error {
  constructor(role: string) {
    super(`invalid role "${role}": must be one of ${ADMIN_ROLES.join(', ')}`)
    this.name = 'InvalidAdminRoleError'
  }
}

/**
 * Raised when remove/role-change would leave the system with no active
 * `owner` — the plane must never be lockable out of its own admin surface
 * (ADR-0004, Decision 3: "last owner is undeletable").
 */
export class LastOwnerError extends Error {
  constructor() {
    super('cannot remove or demote the last owner: at least one active owner must remain')
    this.name = 'LastOwnerError'
  }
}

/** Thrown by the injected validator; surfaced wrapped in `StoreCorruptError`. */
export class AdminsFileInvalidError extends Error {
  constructor(error: z.ZodError) {
    const details = error.issues
      .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
      .join('; ')
    super(`admins file failed validation: ${details}`)
    this.name = 'AdminsFileInvalidError'
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Result of `createAdmin`/`rotateAdmin`: the record plus the ONE-TIME plaintext token. */
export interface CreatedAdmin {
  readonly admin: AdminRecord
  /** Shown to the operator exactly once; unrecoverable afterwards. */
  readonly token: string
}

export interface AdminStore {
  /** Creates a named admin with a fixed role; rejects a duplicate live name. */
  createAdmin(name: string, role: AdminRole): Promise<CreatedAdmin>
  /** Mints a fresh token for an existing admin (kills its live sessions). */
  rotateAdmin(name: string): Promise<CreatedAdmin>
  /** Changes an admin's role; refuses to demote the last active owner. */
  setRole(name: string, role: AdminRole): Promise<AdminRecord>
  /** Soft-removes an admin (sets `revokedAt`); refuses the last active owner. Idempotent. */
  removeAdmin(name: string): Promise<AdminRecord>
  /** The active (non-revoked) admin, or `undefined`. */
  getActiveAdmin(name: string): Promise<AdminRecord | undefined>
  /** All active admins, sorted by name for stable output. */
  listAdmins(): Promise<readonly AdminRecord[]>
  /**
   * Resolves a token to its ACTIVE admin via hash comparison
   * (`timingSafeEqual`). A revoked admin resolves to `undefined`, exactly like
   * a token that never existed; every record is scanned (no early return) so a
   * wrong token costs the same work regardless of match position.
   */
  findAdminByToken(token: string): Promise<AdminRecord | undefined>
}

export interface AdminStoreOptions {
  /** Journal directory override; defaults to `JOURNAL_DIR`. */
  readonly journalDir?: string
  /** Clock override for deterministic timestamps in tests. */
  readonly clock?: () => Date
}

function validateAdminsFile(raw: unknown): AdminsFile {
  const result = adminsFileSchema.safeParse(raw)
  if (!result.success) throw new AdminsFileInvalidError(result.error)
  return result.data
}

function assertValidName(name: string): void {
  if (!ADMIN_NAME_PATTERN.test(name) || RESERVED_OBJECT_KEYS.includes(name)) {
    throw new InvalidAdminNameError(name)
  }
}

function assertValidRole(role: string): asserts role is AdminRole {
  if (!isAdminRole(role)) throw new InvalidAdminRoleError(role)
}

/** Active records only (revoked ones are invisible to every lookup). */
function activeRecord(file: AdminsFile, name: string): AdminRecord | undefined {
  const record = Object.hasOwn(file.admins, name) ? file.admins[name] : undefined
  if (record === undefined || record.revokedAt !== undefined) return undefined
  return record
}

/** New file value with `record` upserted under its name (input untouched). */
function withAdmin(file: AdminsFile, record: AdminRecord): AdminsFile {
  return { ...file, admins: { ...file.admins, [record.name]: record } }
}

/** Count of active owners — the guard that keeps the system unlockable. */
function activeOwnerCount(file: AdminsFile): number {
  return Object.values(file.admins).filter(
    (record) => record.revokedAt === undefined && record.role === 'owner',
  ).length
}

export function createAdminStore(opts: AdminStoreOptions = {}): AdminStore {
  const journalDir = opts.journalDir ?? JOURNAL_DIR
  const clock = opts.clock ?? (() => new Date())
  const store: JsonStore<AdminsFile> = createJsonStore(join(journalDir, ADMINS_FILE_NAME), {
    validate: validateAdminsFile,
    defaultValue: EMPTY_FILE,
  })

  async function createAdmin(name: string, role: AdminRole): Promise<CreatedAdmin> {
    assertValidName(name)
    assertValidRole(role)
    const { token, hash } = generateToken(ADMIN_TOKEN_PREFIX, ADMIN_TOKEN_RANDOM_BYTES)
    const record: AdminRecord = { name, role, tokenHash: hash, createdAt: clock().toISOString() }
    await store.update((current) => {
      if (activeRecord(current, name) !== undefined) throw new AdminExistsError(name)
      return withAdmin(current, record)
    })
    return { admin: record, token }
  }

  async function rotateAdmin(name: string): Promise<CreatedAdmin> {
    const { token, hash } = generateToken(ADMIN_TOKEN_PREFIX, ADMIN_TOKEN_RANDOM_BYTES)
    const next = await store.update((current) => {
      const record = activeRecord(current, name)
      if (record === undefined) throw new AdminNotFoundError(name)
      return withAdmin(current, {
        ...record,
        tokenHash: hash,
        rotatedAt: clock().toISOString(),
      })
    })
    return { admin: next.admins[name] as AdminRecord, token }
  }

  async function setRole(name: string, role: AdminRole): Promise<AdminRecord> {
    assertValidRole(role)
    const next = await store.update((current) => {
      const record = activeRecord(current, name)
      if (record === undefined) throw new AdminNotFoundError(name)
      if (record.role === 'owner' && role !== 'owner' && activeOwnerCount(current) <= 1) {
        throw new LastOwnerError()
      }
      if (record.role === role) return current
      return withAdmin(current, { ...record, role })
    })
    return next.admins[name] as AdminRecord
  }

  async function removeAdmin(name: string): Promise<AdminRecord> {
    const next = await store.update((current) => {
      const record = activeRecord(current, name)
      if (record === undefined) {
        // Idempotent: a second remove of an already-revoked admin is a no-op
        // (keeps the ORIGINAL revocation date), matching the agents store.
        // A name that never existed at all is still a hard error.
        const existing = Object.hasOwn(current.admins, name) ? current.admins[name] : undefined
        if (existing !== undefined && existing.revokedAt !== undefined) return current
        throw new AdminNotFoundError(name)
      }
      if (record.role === 'owner' && activeOwnerCount(current) <= 1) {
        throw new LastOwnerError()
      }
      return withAdmin(current, { ...record, revokedAt: clock().toISOString() })
    })
    const removed = next.admins[name]
    if (removed === undefined) throw new AdminNotFoundError(name)
    return removed
  }

  async function getActiveAdmin(name: string): Promise<AdminRecord | undefined> {
    const file = await store.read()
    return activeRecord(file, name)
  }

  async function listAdmins(): Promise<readonly AdminRecord[]> {
    const file = await store.read()
    return Object.values(file.admins)
      .filter((record) => record.revokedAt === undefined)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async function findAdminByToken(token: string): Promise<AdminRecord | undefined> {
    const file = await store.read()
    let matched: AdminRecord | undefined
    for (const record of Object.values(file.admins)) {
      if (verifyToken(token, record.tokenHash)) matched = record
    }
    if (matched === undefined || matched.revokedAt !== undefined) return undefined
    return matched
  }

  return {
    createAdmin,
    rotateAdmin,
    setRole,
    removeAdmin,
    getActiveAdmin,
    listAdmins,
    findAdminByToken,
  }
}
