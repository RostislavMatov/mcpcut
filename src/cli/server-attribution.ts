import { journalAccessEdit } from '../groups/journal-access-edit.js'
import { formatReadableField } from '../journal/format.js'
import type { AccessEditActor } from '../journal/record.js'
import { adminFromEnv } from './admin-token.js'
import type { ServerCliIo, ServerCliOptions } from './server-cmd.js'

/**
 * WHO changed the registry — shared by `server add` and `server remove`.
 *
 * Attribution is BEST EFFORT on both: these commands predate named admins and
 * run from scripts, so a missing or unusable `MCP_ADMIN_TOKEN` warns once and
 * records "nobody named" rather than refusing a change that never needed a
 * token. Whether either should instead be gated by a role is an owner's
 * decision, not this module's.
 *
 * `add` joined `remove` here after the user-journey smoke (2026-09-18, UX-9):
 * the registry could say who took a server away but not who put it there,
 * although registering one is the command that decides which process the plane
 * may launch — and, since ADR-0008's O8, runs it once through the
 * registration probe.
 */

/** The two registry changes that leave an `access-edit` record. */
export type ServerChange = 'add' | 'remove'

/** Past tense used in the "nobody named" warning; the rest of it is shared. */
const CHANGE_VERB: Readonly<Record<ServerChange, string>> = {
  add: 'registered',
  remove: 'removed',
}

const DROPPED_RECORD_MESSAGE: Readonly<Record<ServerChange, string>> = {
  add: '[journal] the server was registered, but its journal record was dropped (see the sink diagnostics above)\n',
  remove: '[journal] the server was removed, but its journal record was dropped (see the sink diagnostics above)\n',
}

/** The admin behind `MCP_ADMIN_TOKEN`, or an unattributed actor plus one warning. */
export async function serverChangeActor(
  change: ServerChange,
  io: ServerCliIo,
  opts: ServerCliOptions,
): Promise<AccessEditActor> {
  const resolved = await adminFromEnv({
    ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  })
  if (resolved.kind === 'ok') {
    return { adminName: resolved.name, role: resolved.role, via: 'cli' }
  }
  io.stderr.write(
    `[audit] server ${change} not attributed: set MCP_ADMIN_TOKEN to record who ` +
      `${CHANGE_VERB[change]} the server\n`,
  )
  return { adminName: null, role: null, via: 'cli' }
}

/**
 * The audit line (ADR-0009 O5): who changed what. `detail` is appended after
 * the name — `remove` uses it for the cascade summary, `add` has nothing to
 * add.
 */
export function serverAuditLine(
  change: ServerChange,
  actor: AccessEditActor,
  name: string,
  detail = '',
): string {
  const who =
    actor.adminName === null
      ? 'unattributed'
      : `${formatReadableField(actor.adminName)} (${String(actor.role)})`
  return `[audit] server ${change} by ${who}: "${formatReadableField(name)}"${detail}\n`
}

/**
 * Attribution + audit line + journal record for a registration that has
 * ALREADY landed. Never throws and never changes the exit code: the server is
 * registered either way, and a journal that could not be reached is said out
 * loud rather than turned into a failure (the same contract `reportCascade`
 * keeps for the removing half).
 */
export async function reportServerAdd(
  name: string,
  io: ServerCliIo,
  opts: ServerCliOptions,
): Promise<void> {
  const actor = await serverChangeActor('add', io, opts)
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
