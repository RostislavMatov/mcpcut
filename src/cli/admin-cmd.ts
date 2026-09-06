import { parseArgs, type ParseArgsConfig } from 'node:util'
import { ADMIN_ROLES, isAdminRole, type AdminRole } from '../admin/constants.js'
import {
  AdminExistsError,
  AdminNotFoundError,
  createAdminStore,
  InvalidAdminNameError,
  InvalidAdminRoleError,
  LastOwnerError,
  type AdminRecord,
  type AdminStore,
  type AdminStoreOptions,
} from '../admin/store.js'
import { formatReadableField } from '../journal/format.js'
import { StoreCorruptError, StoreLockError, StoreWriteRejectedError } from '../policy/store.js'
import { UNATTRIBUTED_ACTOR, type AccessActor } from './access-cmd-write.js'
import { recordChange, requireListOwner, requireOwner } from './admin-cmd-write.js'
import {
  ADMIN_USAGE,
  TOKEN_ONCE_NOTICE,
  TOKEN_STDOUT_REDIRECT_WARNING,
  type AdminCliIo,
} from './ui-constants.js'

/**
 * `admin add|list|remove|rotate|role` (M4 Task 16) — operator-facing management
 * of the named admin identities the UI authenticates against. Same shape as
 * `agent-cmd.ts`: exported function, injectable io and store options, so tests
 * drive it without touching the real journal dir or process stdio.
 *
 * Every subcommand needs a personal admin token of role `owner` in
 * `MCP_ADMIN_TOKEN`, and every MUTATION leaves an `access-edit` journal record
 * naming the admin it touched (owner decision 2026-09-06; the gate, the
 * wording and the record live in `admin-cmd-write.ts`). The two token-free
 * paths are named there too: the first admin of an empty store and
 * `admin rotate --recover`.
 *
 * The ONE place a plaintext admin token ever surfaces is stdout, once, in
 * `add` and `rotate`. It is never written to disk (`admins.json` holds only the
 * sha256 hash), never echoed to stderr, never put in a journal record and
 * never recoverable afterwards.
 *
 * Names and roles are operator-typed but the records they select come back
 * from a store file, so every string is routed through `formatReadableField`
 * before it reaches a terminal — the same untrusted-field discipline the rest
 * of the CLI applies.
 */

/** Test seams: journal dir and clock (forwarded to the store), and the token environment. */
export interface AdminCliOptions extends AdminStoreOptions {
  /** Environment holding `MCP_ADMIN_TOKEN`. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
}

export type { AdminCliIo } from './ui-constants.js'

const DEFAULT_IO: AdminCliIo = { stdout: process.stdout, stderr: process.stderr }

/** Errors this command turns into an exit-1 message instead of a crash. */
const EXPECTED_ERRORS = [
  AdminExistsError,
  AdminNotFoundError,
  InvalidAdminNameError,
  InvalidAdminRoleError,
  LastOwnerError,
  StoreCorruptError,
  StoreLockError,
  StoreWriteRejectedError,
] as const

/**
 * Exported so every command that touches the admin store classifies its
 * failures through ONE path: `approvals approve|deny` resolves the operator's
 * token against the same store and must refuse the same way this command does,
 * rather than carrying a second, drifting copy of the list.
 */
export function isExpectedAdminError(error: unknown): error is Error {
  return EXPECTED_ERRORS.some((kind) => error instanceof kind)
}

/** Prints the usage block plus an optional leading explanation. */
function usage(io: AdminCliIo, message?: string): number {
  io.stderr.write(message === undefined ? ADMIN_USAGE : `${message}\n\n${ADMIN_USAGE}`)
  return 1
}

/**
 * Dispatches one `admin ...` subcommand and returns a process exit code. Only
 * unexpected (programming/filesystem) errors propagate as rejections.
 */
export async function runAdminCommand(
  args: string[],
  io: AdminCliIo = DEFAULT_IO,
  opts: AdminCliOptions = {},
): Promise<number> {
  const [subcommand, ...rest] = args
  const store = createAdminStore(opts)

  try {
    switch (subcommand) {
      case 'add':
        return await runAdd(rest, io, opts, store)
      case 'list':
        return await runList(rest, io, opts, store)
      case 'remove':
        return await runRemove(rest, io, opts, store)
      case 'rotate':
        return await runRotate(rest, io, opts, store)
      case 'role':
        return await runRole(rest, io, opts, store)
      default:
        return usage(io)
    }
  } catch (error: unknown) {
    if (isExpectedAdminError(error)) {
      io.stderr.write(`${formatReadableField(error.message)}\n`)
      return 1
    }
    throw error
  }
}

/** The flags one subcommand accepts; anything else it is given is a usage error. */
type AdminFlags = NonNullable<ParseArgsConfig['options']>

const NO_FLAGS: AdminFlags = {}
const ROLE_FLAG: AdminFlags = { role: { type: 'string' } }
const RECOVER_FLAG: AdminFlags = { recover: { type: 'boolean' } }

/** What one parsed invocation carries; `recover` is false unless `rotate` saw the flag. */
interface ParsedAdminArgs {
  readonly positionals: string[]
  readonly role: string | undefined
  readonly recover: boolean
}

/** Strict positional+flag parse; a malformed invocation yields `null`. */
function parseAdminArgs(args: readonly string[], flags: AdminFlags): ParsedAdminArgs | null {
  try {
    const parsed = parseArgs({ args: [...args], options: flags, allowPositionals: true, strict: true })
    const role = parsed.values['role']
    return {
      positionals: parsed.positionals,
      role: typeof role === 'string' ? role : undefined,
      recover: parsed.values['recover'] === true,
    }
  } catch {
    return null
  }
}

async function runAdd(
  args: readonly string[],
  io: AdminCliIo,
  opts: AdminCliOptions,
  store: AdminStore,
): Promise<number> {
  const parsed = parseAdminArgs(args, ROLE_FLAG)
  if (parsed === null || parsed.positionals.length !== 1) return usage(io)

  const name = parsed.positionals.length === 1 ? parsed.positionals[0] : undefined
  if (name === undefined) return usage(io)
  if (parsed.role === undefined) {
    return usage(io, `admin add requires --role (one of ${ADMIN_ROLES.join(', ')}).`)
  }
  const role = parsed.role
  if (!isAdminRole(role)) {
    return usage(
      io,
      `Invalid role "${formatReadableField(role)}": expected one of ${ADMIN_ROLES.join(', ')}.`,
    )
  }

  // Refused BEFORE the write: an identity created by nobody-in-particular is
  // exactly what the 2026-09-06 decision exists to prevent.
  const actor = await addActor(io, opts, store)
  if (actor === undefined) return 1

  const { admin, token } = await store.createAdmin(name, role)
  io.stdout.write(`admin: ${formatReadableField(admin.name)}\n`)
  io.stdout.write(`role: ${admin.role}\n`)
  io.stdout.write(`token: ${token}\n`)
  io.stdout.write(TOKEN_ONCE_NOTICE)
  io.stdout.write(TOKEN_STDOUT_REDIRECT_WARNING)
  // The record names the admin and the role given — never the token above.
  return recordChange(io, opts, actor, 'add', roleTarget(name, role), {
    action: 'admin.add',
    admin: name,
    targetRole: role,
  })
}

/**
 * Who the new admin is created by. On an EMPTY store that is nobody: the
 * first admin of an installation cannot present a token that does not exist
 * yet, so the bootstrap is token-free and recorded as unattributed. Every
 * later one needs an owner.
 */
async function addActor(
  io: AdminCliIo,
  opts: AdminCliOptions,
  store: AdminStore,
): Promise<AccessActor | undefined> {
  const admins = await store.listAdmins()
  if (admins.length === 0) return UNATTRIBUTED_ACTOR
  return requireOwner(io, opts)
}

async function runList(
  args: readonly string[],
  io: AdminCliIo,
  opts: AdminCliOptions,
  store: AdminStore,
): Promise<number> {
  const parsed = parseAdminArgs(args, NO_FLAGS)
  if (parsed === null || parsed.positionals.length !== 0) return usage(io)

  const admins = await store.listAdmins()
  if (admins.length === 0) {
    io.stdout.write('(no admins)\n')
    return 0
  }
  // The roster names every human who can reach this plane, which is what
  // `GET /admins → owner` says of the web surface. Reading is not a change,
  // so the gate is here and no record follows it.
  if ((await requireListOwner(io, opts)) === undefined) return 1
  for (const admin of admins) {
    io.stdout.write(`${formatAdminLine(admin)}\n`)
  }
  return 0
}

/**
 * One admin per line: name, role and dates. Deliberately never the token hash —
 * a hash is a credential verifier, and an operator listing admins has no use
 * for one (Task 16 test: `admin list` shows no hashes).
 */
function formatAdminLine(admin: AdminRecord): string {
  const name = formatReadableField(admin.name)
  const created = `created ${formatReadableField(admin.createdAt)}`
  const rotated =
    admin.rotatedAt === undefined ? '' : `  rotated ${formatReadableField(admin.rotatedAt)}`
  return `${name.padEnd(24)}  ${admin.role.padEnd(8)}  ${created}${rotated}`
}

/** `<name> (<role>)` — what the audit line says when the change carries a role. */
function roleTarget(name: string, role: AdminRole): string {
  return `${formatReadableField(name)} (${role})`
}

async function runRemove(
  args: readonly string[],
  io: AdminCliIo,
  opts: AdminCliOptions,
  store: AdminStore,
): Promise<number> {
  const parsed = parseAdminArgs(args, NO_FLAGS)
  if (parsed === null || parsed.positionals.length !== 1) return usage(io)

  const name = parsed.positionals.length === 1 ? parsed.positionals[0] : undefined
  if (name === undefined) return usage(io)

  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1

  const admin = await store.removeAdmin(name)
  io.stdout.write(
    `removed ${formatReadableField(admin.name)} at ${formatReadableField(admin.revokedAt ?? '')}\n`,
  )
  return recordChange(io, opts, actor, 'remove', formatReadableField(name), {
    action: 'admin.remove',
    admin: name,
  })
}

async function runRotate(
  args: readonly string[],
  io: AdminCliIo,
  opts: AdminCliOptions,
  store: AdminStore,
): Promise<number> {
  const parsed = parseAdminArgs(args, RECOVER_FLAG)
  if (parsed === null || parsed.positionals.length !== 1) return usage(io)

  const name = parsed.positionals.length === 1 ? parsed.positionals[0] : undefined
  if (name === undefined) return usage(io)

  // `--recover` is the way back in when the last owner lost their token: no
  // token is asked for, and the record says the rotation was a recovery
  // nobody signed. It removes no barrier that was there (a process under the
  // same uid rewrites the store either way) and adds the trace.
  const actor = parsed.recover ? UNATTRIBUTED_ACTOR : await requireOwner(io, opts)
  if (actor === undefined) return 1

  const { admin, token } = await store.rotateAdmin(name)
  io.stdout.write(`admin: ${formatReadableField(admin.name)}\n`)
  io.stdout.write(`token: ${token}\n`)
  io.stdout.write(TOKEN_ONCE_NOTICE)
  io.stdout.write(TOKEN_STDOUT_REDIRECT_WARNING)
  io.stdout.write(`Any browser session held by ${formatReadableField(admin.name)} is now invalid.\n`)
  return recordChange(io, opts, actor, 'rotate', formatReadableField(name), {
    action: 'admin.rotate',
    admin: name,
    ...(parsed.recover ? { recovery: true as const } : {}),
  })
}

async function runRole(
  args: readonly string[],
  io: AdminCliIo,
  opts: AdminCliOptions,
  store: AdminStore,
): Promise<number> {
  const parsed = parseAdminArgs(args, NO_FLAGS)
  if (parsed === null || parsed.positionals.length !== 2) return usage(io)

  const name = parsed.positionals.length === 2 ? parsed.positionals[0] : undefined
  const role = parsed.positionals.length === 2 ? parsed.positionals[1] : undefined
  if (name === undefined || role === undefined) return usage(io)
  if (!isAdminRole(role)) {
    return usage(
      io,
      `Invalid role "${formatReadableField(role)}": expected one of ${ADMIN_ROLES.join(', ')}.`,
    )
  }

  const actor = await requireOwner(io, opts)
  if (actor === undefined) return 1

  const admin = await store.setRole(name, role)
  io.stdout.write(`${formatReadableField(admin.name)} is now ${admin.role}\n`)
  return recordChange(io, opts, actor, 'role', roleTarget(name, role), {
    action: 'admin.role',
    admin: name,
    targetRole: role,
  })
}
