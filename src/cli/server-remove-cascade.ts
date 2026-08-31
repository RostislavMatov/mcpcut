import { GRANT_SERVER_NAME_PATTERN } from '../agents/constants.js'
import { createAgentsStore } from '../agents/store.js'
import { journalAccessEdit } from '../groups/journal-access-edit.js'
import { createGroupsStore } from '../groups/store.js'
import { formatReadableField } from '../journal/format.js'
import type { CascadeHalfStatus, CascadeVerdict } from '../journal/access-edit-record.js'
import type { AccessEditActor } from '../journal/record.js'
import { adminFromEnv } from './admin-token.js'
import type { ServerCliIo, ServerCliOptions } from './server-cmd.js'

/**
 * The cascade side of `server remove` (M5.5 п.2, owner decision G6): the
 * server is dropped from every personal grant and every group grant, the
 * change is said out loud on stderr and recorded as one `access-edit` journal
 * record. Split out of `server-cmd.ts` for the file-size budget, exactly like
 * `server-status-cmd.ts`.
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
  /** Which halves actually ran; a `failed` half contributed no names. */
  readonly verdict: CascadeVerdict
}

const UNATTRIBUTED_MESSAGE =
  '[audit] server remove not attributed: set MCP_ADMIN_TOKEN to record who removed the server\n'

const DROPPED_RECORD_MESSAGE =
  '[journal] the server was removed, but its journal record was dropped (see the sink diagnostics above)\n'

/** `N agent grants, M groups` — the same phrasing on stderr and stdout. */
export function cascadeSummary(cascade: CascadeResult): string {
  return `${cascade.affectedAgents.length} agent grants, ${cascade.affectedGroups.length} groups`
}

/** True when either half actually pruned something. */
export function cascadeTouchedAnything(cascade: CascadeResult): boolean {
  return cascade.affectedAgents.length > 0 || cascade.affectedGroups.length > 0
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One half of the cascade, isolated: a failure is REPORTED and recorded, never
 * propagated. The two stores are independent documents, so a broken
 * `groups.json` must not also stop the agents half from being pruned.
 */
async function runHalf(
  half: keyof CascadeVerdict,
  name: string,
  io: ServerCliIo,
  run: () => Promise<readonly string[]>,
): Promise<{ readonly affected: readonly string[]; readonly status: CascadeHalfStatus }> {
  try {
    return { affected: await run(), status: 'done' }
  } catch (error: unknown) {
    io.stderr.write(
      `[cascade] the ${half} half of "server remove ${formatReadableField(name)}" failed: ` +
        `${describeError(error)}\n` +
        `[cascade] grants for "${formatReadableField(name)}" may still dangle in the ${half} store; ` +
        `fix it and re-run "server remove ${formatReadableField(name)}" to prune them\n`,
    )
    return { affected: [], status: 'failed' }
  }
}

/**
 * Drops the removed server from every agent grant and every group grant.
 *
 * Contract (relied on by `runServerRemove` and mirrored by the UI handler):
 *  - NEVER throws — each half is isolated, and a failed half is reported on
 *    stderr and returned as `verdict.<half> === 'failed'`;
 *  - both halves are IDEMPOTENT, which is what makes re-running
 *    `server remove` on an already-unregistered name a repair rather than a
 *    no-op (three documents, no shared transaction: a crash between them
 *    leaves a dangling grant);
 *  - it is safe to call BEFORE knowing whether the registry still holds the
 *    server — a name no grant could ever carry short-circuits to an empty,
 *    successful result.
 */
export async function cascadeGrants(
  name: string,
  io: ServerCliIo,
  opts: ServerCliOptions,
): Promise<CascadeResult> {
  // A name outside the grant shape can never appear as a grant key, so there
  // is nothing to prune and nothing to warn about — asking the agents store
  // would only raise `InvalidServerNameError` on a plain typo.
  if (!GRANT_SERVER_NAME_PATTERN.test(name)) {
    return { affectedAgents: [], affectedGroups: [], verdict: { agents: 'done', groups: 'done' } }
  }
  const storeOpts = opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}
  const agents = await runHalf('agents', name, io, () =>
    createAgentsStore(storeOpts).ungrantServerEverywhere(name),
  )
  const groups = await runHalf('groups', name, io, () =>
    createGroupsStore(storeOpts).ungrantServerEverywhere(name),
  )
  return {
    affectedAgents: agents.affected,
    affectedGroups: groups.affected,
    verdict: { agents: agents.status, groups: groups.status },
  }
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
      cascade: cascade.verdict,
    },
    ...(opts.journalDir !== undefined ? { dir: opts.journalDir } : {}),
    diagnostics: (line) => io.stderr.write(line),
  })
  if (!outcome.written) {
    io.stderr.write(DROPPED_RECORD_MESSAGE)
  }
}

/**
 * Attribution + audit line + journal record for a cascade that already ran.
 * Emitted UNCONDITIONALLY once the change is applied — including when a half
 * failed — so an applied change never goes unrecorded.
 */
export async function reportCascade(
  name: string,
  cascade: CascadeResult,
  io: ServerCliIo,
  opts: ServerCliOptions,
): Promise<void> {
  const actor = await removeActor(io, opts)
  io.stderr.write(auditLineOf(actor, name, cascade))
  await journalRemoval(actor, name, cascade, io, opts)
}

/**
 * Runs the whole post-registry half of `server remove`: cascade, attribution,
 * audit line, journal record. Returns what was touched so the caller can
 * report it on stdout. Never throws — see `cascadeGrants`.
 */
export async function cascadeServerRemoval(
  name: string,
  io: ServerCliIo,
  opts: ServerCliOptions,
): Promise<CascadeResult> {
  const cascade = await cascadeGrants(name, io, opts)
  await reportCascade(name, cascade, io, opts)
  return cascade
}
