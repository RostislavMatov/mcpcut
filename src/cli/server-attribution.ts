import type { Role } from '../admin/authz.js'
import { journalAccessEdit } from '../groups/journal-access-edit.js'
import { formatReadableField } from '../journal/format.js'
import { requireAccessOwner } from './access-cmd-write.js'
import type { AdminRefusalWording } from './admin-token.js'
import type { ServerCliIo, ServerCliOptions } from './server-cmd.js'

/**
 * WHO changed the registry — shared by `server add` and `server remove`.
 *
 * Both are OWNER-ONLY (owner decision 2026-09-18, user-journey smoke UX-9):
 * no `MCP_ADMIN_TOKEN`, an unknown one or a role below `owner` refuses the
 * command before anything is read or written. Until then attribution was best
 * effort — a missing token recorded "nobody named" and the change went ahead —
 * which left the shell wider than the admin UI, where both `/servers` write
 * routes have always been `owner`. Registering a server decides which process
 * the plane may launch and, since ADR-0008's O8, RUNS it once through the
 * registration probe; removing one rewrites every grant that named it.
 *
 * The token buys attribution and parity with the UI's role table, not an
 * access barrier: a process under the same uid edits `state.db` directly
 * (ADR-0004). `server list|show` stay open, `server refresh` is `operator`.
 */

/** The two registry changes that leave an `access-edit` record. */
export type ServerChange = 'add' | 'remove'

/** The owner a registry change is attributed to — always named since the gate. */
export interface ServerChangeActor {
  readonly adminName: string
  readonly role: Role
  readonly via: 'cli'
}

/** How the shared token gate names this command family's refusals. */
const SERVER_REFUSAL: AdminRefusalWording = {
  action: 'change the server registry',
  noun: 'change',
  verb: 'may not register or remove servers',
  roleDetail: 'the same rule the admin UI applies to the /servers routes',
}

const DROPPED_RECORD_MESSAGE: Readonly<Record<ServerChange, string>> = {
  add: '[journal] the server was registered, but its journal record was dropped (see the sink diagnostics above)\n',
  remove: '[journal] the server was removed, but its journal record was dropped (see the sink diagnostics above)\n',
}

/** The owner behind `MCP_ADMIN_TOKEN`, or `undefined` with the refusal already printed. */
export async function requireServerOwner(
  io: ServerCliIo,
  opts: ServerCliOptions,
): Promise<ServerChangeActor | undefined> {
  const admin = await requireAccessOwner(io, opts, SERVER_REFUSAL)
  if (admin === undefined) return undefined
  return { adminName: admin.adminName, role: admin.role, via: 'cli' }
}

/**
 * The audit line (ADR-0009 O5): who changed what. `detail` is appended after
 * the name — `remove` uses it for the cascade summary, `add` has nothing to
 * add.
 */
export function serverAuditLine(
  change: ServerChange,
  actor: ServerChangeActor,
  name: string,
  detail = '',
): string {
  const who = `${formatReadableField(actor.adminName)} (${actor.role})`
  return `[audit] server ${change} by ${who}: "${formatReadableField(name)}"${detail}\n`
}

/**
 * Audit line + journal record for a registration that has ALREADY landed.
 * Never throws and never changes the exit code: the server is registered
 * either way, and a journal that could not be reached is said out loud rather
 * than turned into a failure (the same contract `reportCascade` keeps for the
 * removing half).
 */
export async function reportServerAdd(
  name: string,
  actor: ServerChangeActor,
  io: ServerCliIo,
  opts: ServerCliOptions,
): Promise<void> {
  io.stderr.write(serverAuditLine('add', actor, name))
  const outcome = await journalAccessEdit({
    info: { actor, action: 'server.add', server: name },
    ...(opts.journalDir !== undefined ? { dir: opts.journalDir } : {}),
    diagnostics: (line) => io.stderr.write(line),
  })
  if (!outcome.written) io.stderr.write(DROPPED_RECORD_MESSAGE.add)
}

/** The removing half's dropped-record line, so both messages live together. */
export const REMOVE_DROPPED_RECORD_MESSAGE = DROPPED_RECORD_MESSAGE.remove
