import { GRANT_SERVER_NAME_PATTERN } from '../agents/constants.js'
import { createAgentsStore } from '../agents/store.js'
import { journalAccessEdit } from '../groups/journal-access-edit.js'
import { createGroupsStore } from '../groups/store.js'
import { formatReadableField } from '../journal/format.js'
import { RESERVED_OBJECT_KEYS } from '../policy/constants.js'
import type { CascadeHalfStatus, CascadeVerdict } from '../journal/access-edit-record.js'
import {
  REMOVE_DROPPED_RECORD_MESSAGE,
  serverAuditLine,
  type ServerChangeActor,
} from './server-attribution.js'
import { countGrantReferences, type GrantReferenceCount } from './server-grant-refs.js'
import type { ServerCliIo, ServerCliOptions } from './server-cmd.js'

/**
 * The cascade side of `server remove` (M5.5 п.2, owner decision G6): the
 * server is dropped from every personal grant and every group grant, the
 * change is said out loud on stderr and recorded as one `access-edit` journal
 * record. Split out of `server-cmd.ts` for the file-size budget, exactly like
 * `server-status-cmd.ts`.
 *
 * The actor is ALWAYS a named owner (owner decision 2026-09-18): the gate in
 * `server-attribution.ts` runs before `runServerRemove` touches anything, so
 * the best-effort "nobody named" record this module used to write (plan
 * m55-server-groups, open detail 2) no longer has a way to arise from here.
 */

/** What the cascade touched — for the audit line, the record and stdout. */
export interface CascadeResult {
  readonly affectedAgents: readonly string[]
  readonly affectedGroups: readonly string[]
  /** Which halves actually ran; a `failed` half contributed no names. */
  readonly verdict: CascadeVerdict
}

/** `N agent grants, M groups` — the same phrasing on stderr and stdout. */
export function cascadeSummary(cascade: CascadeResult): string {
  return `${cascade.affectedAgents.length} agent grants, ${cascade.affectedGroups.length} groups`
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
  // A name no grant key can hold — outside the grant shape, or a reserved
  // object key every store refuses — has nothing to prune and nothing to warn
  // about. Asking the stores anyway would raise `InvalidServerNameError` and
  // turn a plain typo into a "fix it and re-run" diagnostic the operator can
  // never satisfy.
  if (!GRANT_SERVER_NAME_PATTERN.test(name) || RESERVED_OBJECT_KEYS.includes(name)) {
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

/** Records the cascade; a dropped record is reported, never fatal — the removal already happened. */
async function journalRemoval(
  actor: ServerChangeActor,
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
    io.stderr.write(REMOVE_DROPPED_RECORD_MESSAGE)
  }
}

/**
 * Audit line + journal record for a cascade that already ran. Emitted
 * UNCONDITIONALLY once the change is applied — including when a half failed —
 * so an applied change never goes unrecorded.
 */
export async function reportCascade(
  name: string,
  cascade: CascadeResult,
  actor: ServerChangeActor,
  io: ServerCliIo,
  opts: ServerCliOptions,
): Promise<void> {
  io.stderr.write(serverAuditLine('remove', actor, name, `, cascaded: ${cascadeSummary(cascade)}`))
  await journalRemoval(actor, name, cascade, io, opts)
}

/**
 * Runs the whole post-registry half of `server remove`: cascade, audit line,
 * journal record — attributed to the owner the gate already resolved. Returns
 * what was touched so the caller can report it on stdout. Never throws — see
 * `cascadeGrants`.
 */
export async function cascadeServerRemoval(
  name: string,
  actor: ServerChangeActor,
  io: ServerCliIo,
  opts: ServerCliOptions,
): Promise<CascadeResult> {
  const cascade = await cascadeGrants(name, io, opts)
  await reportCascade(name, cascade, actor, io, opts)
  return cascade
}

/**
 * The `not-found` branch of `server remove` WITHOUT `--prune-grants` (owner
 * decision T5, 2026-09-01): a name the registry does not hold is a plain
 * refusal that writes NOTHING. Until T5 this branch silently ran both cascade
 * halves, so "remove" and "repair" were the same word; now the dangling grants
 * are only COUNTED (read-only) and named in a hint, and pruning them is a
 * second, deliberate command.
 *
 * A failed count is reported and does not change the outcome: the refusal
 * stands either way, and "I could not look" must not read as "nothing dangles".
 */
export async function refuseUnknownServer(
  name: string,
  io: ServerCliIo,
  opts: ServerCliOptions,
): Promise<number> {
  io.stderr.write(`unknown server "${formatReadableField(name)}"\n`)
  let counts: GrantReferenceCount
  try {
    counts = await countGrantReferences(name, opts)
  } catch (error: unknown) {
    io.stderr.write(
      `[warn] could not check dangling grants for "${formatReadableField(name)}": ${describeError(error)}\n`,
    )
    return 1
  }
  if (counts.agents === 0 && counts.groups === 0) return 1
  io.stderr.write(
    `dangling grants: ${counts.agents} agent grants, ${counts.groups} groups — ` +
      `prune with: server remove --prune-grants ${formatReadableField(name)}\n`,
  )
  return 1
}
