import { createAgentsStore } from '../agents/store.js'
import { journalAccessEdit } from '../groups/journal-access-edit.js'
import { createGroupsStore } from '../groups/store.js'
import { formatReadableField } from '../journal/format.js'
import type { AccessEditActor } from '../journal/record.js'
import { adminFromEnv } from './admin-token.js'
import type { ServerCliIo, ServerCliOptions } from './server-cmd.js'

/**
 * The cascade side of `server remove` (M5.5 п.2, owner decision G6): once the
 * registry write succeeded, the server is dropped from every personal grant
 * and every group grant, the change is said out loud on stderr and recorded
 * as one `access-edit` journal record. Split out of `server-cmd.ts` for the
 * file-size budget, exactly like `server-status-cmd.ts`.
 *
 * Attribution is BEST EFFORT (plan m55-server-groups, open detail 2):
 * `server remove` predates named admins and runs from scripts, so a missing
 * or unusable `MCP_ADMIN_TOKEN` warns once and records "nobody named" instead
 * of refusing a removal that never needed a token.
 */

/** What the cascade touched — for the audit line, the record and stdout. */
export interface CascadeResult {
  readonly affectedAgents: readonly string[]
  readonly affectedGroups: readonly string[]
}

const UNATTRIBUTED_MESSAGE =
  '[audit] server remove not attributed: set MCP_ADMIN_TOKEN to record who removed the server\n'

const DROPPED_RECORD_MESSAGE =
  '[journal] the server was removed, but its journal record was dropped (see the sink diagnostics above)\n'

/** `N agent grants, M groups` — the same phrasing on stderr and stdout. */
export function cascadeSummary(cascade: CascadeResult): string {
  return `${cascade.affectedAgents.length} agent grants, ${cascade.affectedGroups.length} groups`
}

/**
 * Drops the removed server from every agent grant and every group grant.
 * Called only AFTER the registry write: the registry is the source of truth,
 * and a grant left pointing at a server that no longer exists is today's
 * tolerated state, while grants stripped from a server the registry still
 * lists is not.
 *
 * Three documents mean three independent compare-and-swap writes with no
 * shared transaction: a crash between them leaves a dangling grant, which
 * repeating the same removal repairs — both cascade calls are idempotent.
 */
async function cascadeGrants(name: string, opts: ServerCliOptions): Promise<CascadeResult> {
  const storeOpts = opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}
  const affectedAgents = await createAgentsStore(storeOpts).ungrantServerEverywhere(name)
  const affectedGroups = await createGroupsStore(storeOpts).ungrantServerEverywhere(name)
  return { affectedAgents, affectedGroups }
}

/** The admin behind `MCP_ADMIN_TOKEN`, or an unattributed actor plus one warning. */
async function removeActor(io: ServerCliIo, opts: ServerCliOptions): Promise<AccessEditActor> {
  const resolved = await adminFromEnv({
    ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  })
  if (resolved.kind === 'ok') {
    return { adminName: resolved.name, role: resolved.role, via: 'cli' }
  }
  io.stderr.write(UNATTRIBUTED_MESSAGE)
  return { adminName: null, role: null, via: 'cli' }
}

/** The audit line (ADR-0009 O5): who removed what, and how far it reached. */
function auditLineOf(actor: AccessEditActor, name: string, cascade: CascadeResult): string {
  const who =
    actor.adminName === null
      ? 'unattributed'
      : `${formatReadableField(actor.adminName)} (${String(actor.role)})`
  return `[audit] server remove by ${who}: "${formatReadableField(name)}", cascaded: ${cascadeSummary(cascade)}\n`
}

/** Records the cascade; a dropped record is reported, never fatal — the removal already happened. */
async function journalRemoval(
  actor: AccessEditActor,
  name: string,
  cascade: CascadeResult,
  io: ServerCliIo,
  opts: ServerCliOptions,
): Promise<void> {
  const outcome = await journalAccessEdit({
    info: {
      actor,
      action: 'server.remove',
      server: name,
      affectedAgents: cascade.affectedAgents,
      affectedGroups: cascade.affectedGroups,
    },
    ...(opts.journalDir !== undefined ? { dir: opts.journalDir } : {}),
    diagnostics: (line) => io.stderr.write(line),
  })
  if (!outcome.written) {
    io.stderr.write(DROPPED_RECORD_MESSAGE)
  }
}

/**
 * Runs the whole post-registry half of `server remove`: cascade, attribution,
 * audit line, journal record. Returns what was touched so the caller can
 * report it on stdout.
 */
export async function cascadeServerRemoval(
  name: string,
  io: ServerCliIo,
  opts: ServerCliOptions,
): Promise<CascadeResult> {
  const cascade = await cascadeGrants(name, opts)
  const actor = await removeActor(io, opts)
  io.stderr.write(auditLineOf(actor, name, cascade))
  await journalRemoval(actor, name, cascade, io, opts)
  return cascade
}
