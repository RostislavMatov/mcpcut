import { parseArgs } from 'node:util'
import { ADMIN_ROLES, isAdminRole } from '../admin/constants.js'
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
import { StoreCorruptError, StoreLockError } from '../policy/store.js'
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
 * The ONE place a plaintext admin token ever surfaces is stdout, once, in
 * `add` and `rotate`. It is never written to disk (`admins.json` holds only the
 * sha256 hash), never echoed to stderr and never recoverable afterwards.
 *
 * Names and roles are operator-typed but the records they select come back
 * from a store file, so every string is routed through `formatReadableField`
 * before it reaches a terminal — the same untrusted-field discipline the rest
 * of the CLI applies.
 */

/** Test seams: journal dir and clock, forwarded to the store. */
export type AdminCliOptions = AdminStoreOptions

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
] as const

function isExpectedError(error: unknown): error is Error {
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
        return await runAdd(rest, io, store)
      case 'list':
        return await runList(rest, io, store)
      case 'remove':
        return await runRemove(rest, io, store)
      case 'rotate':
        return await runRotate(rest, io, store)
      case 'role':
        return await runRole(rest, io, store)
      default:
        return usage(io)
    }
  } catch (error: unknown) {
    if (isExpectedError(error)) {
      io.stderr.write(`${formatReadableField(error.message)}\n`)
      return 1
    }
    throw error
  }
}

/** Strict positional+flag parse; a malformed invocation yields `null`. */
function parseAdminArgs(
  args: readonly string[],
  withRoleFlag: boolean,
): { positionals: string[]; role: string | undefined } | null {
  try {
    const parsed = parseArgs({
      args: [...args],
      options: withRoleFlag ? { role: { type: 'string' } } : {},
      allowPositionals: true,
      strict: true,
    })
    const role = parsed.values.role
    return { positionals: parsed.positionals, role: typeof role === 'string' ? role : undefined }
  } catch {
    return null
  }
}

async function runAdd(args: readonly string[], io: AdminCliIo, store: AdminStore): Promise<number> {
  const parsed = parseAdminArgs(args, true)
  if (parsed === null || parsed.positionals.length !== 1) return usage(io)

  const name = parsed.positionals.length === 1 ? parsed.positionals[0] : undefined
  if (name === undefined) return usage(io)
  if (parsed.role === undefined) {
    return usage(io, `admin add requires --role (one of ${ADMIN_ROLES.join(', ')}).`)
  }
  if (!isAdminRole(parsed.role)) {
    return usage(
      io,
      `Invalid role "${formatReadableField(parsed.role)}": expected one of ${ADMIN_ROLES.join(', ')}.`,
    )
  }

  const { admin, token } = await store.createAdmin(name, parsed.role)
  io.stdout.write(`admin: ${formatReadableField(admin.name)}\n`)
  io.stdout.write(`role: ${admin.role}\n`)
  io.stdout.write(`token: ${token}\n`)
  io.stdout.write(TOKEN_ONCE_NOTICE)
  io.stdout.write(TOKEN_STDOUT_REDIRECT_WARNING)
  return 0
}

async function runList(args: readonly string[], io: AdminCliIo, store: AdminStore): Promise<number> {
  const parsed = parseAdminArgs(args, false)
  if (parsed === null || parsed.positionals.length !== 0) return usage(io)

  const admins = await store.listAdmins()
  if (admins.length === 0) {
    io.stdout.write('(no admins)\n')
    return 0
  }
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

async function runRemove(
  args: readonly string[],
  io: AdminCliIo,
  store: AdminStore,
): Promise<number> {
  const parsed = parseAdminArgs(args, false)
  if (parsed === null || parsed.positionals.length !== 1) return usage(io)

  const name = parsed.positionals.length === 1 ? parsed.positionals[0] : undefined
  if (name === undefined) return usage(io)

  const admin = await store.removeAdmin(name)
  io.stdout.write(
    `removed ${formatReadableField(admin.name)} at ${formatReadableField(admin.revokedAt ?? '')}\n`,
  )
  return 0
}

async function runRotate(
  args: readonly string[],
  io: AdminCliIo,
  store: AdminStore,
): Promise<number> {
  const parsed = parseAdminArgs(args, false)
  if (parsed === null || parsed.positionals.length !== 1) return usage(io)

  const name = parsed.positionals.length === 1 ? parsed.positionals[0] : undefined
  if (name === undefined) return usage(io)

  const { admin, token } = await store.rotateAdmin(name)
  io.stdout.write(`admin: ${formatReadableField(admin.name)}\n`)
  io.stdout.write(`token: ${token}\n`)
  io.stdout.write(TOKEN_ONCE_NOTICE)
  io.stdout.write(TOKEN_STDOUT_REDIRECT_WARNING)
  io.stdout.write(`Any browser session held by ${formatReadableField(admin.name)} is now invalid.\n`)
  return 0
}

async function runRole(args: readonly string[], io: AdminCliIo, store: AdminStore): Promise<number> {
  const parsed = parseAdminArgs(args, false)
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

  const admin = await store.setRole(name, role)
  io.stdout.write(`${formatReadableField(admin.name)} is now ${admin.role}\n`)
  return 0
}
