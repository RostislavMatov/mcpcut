import type { AgentsStore } from '../../agents/store.js'
import type { GroupsStore } from '../../groups/store.js'
import type { AccessEditInfo } from '../../journal/record.js'
import type { RegistryStore } from '../../registry/store.js'
import { HTTP_STATUS_NOT_FOUND, HTTP_STATUS_OK } from '../constants.js'
import { renderRemoveWarning } from '../pages/servers.js'
import type { UiHandler, UiRequestContext, UiResult } from '../routes.js'
import { csrfTokenOf, currentAdminOf, fieldsOf, redirect } from './request-helpers.js'

/**
 * `POST /servers/remove` — the interstitial, the removal and the G6 cascade
 * (ADR-0010 §5), lifted out of `handlers/servers.ts` so that file stays under
 * the 400-line ceiling and this one flow reads end to end in one place.
 *
 * The invariant this module exists to hold: once `removeServer` has returned,
 * the removal HAPPENED. Nothing after it — neither cascade half, nor the
 * journal — may turn that into a 500 or, worse, swallow the record of it. So
 * each half is contained on its own, the audit line and the `access-edit`
 * record are always emitted with WHAT LANDED, and the response is the same
 * 303 either way. A half that failed leaves a dangling grant, which is
 * today's tolerated state and which repeating the removal repairs (both
 * cascade calls are idempotent) — the diagnostic says so out loud.
 */

/** One attributed UI mutation, for the audit sink. */
export interface ServerRemoveAuditEvent {
  readonly actor: 'ui'
  readonly adminName: string
  readonly action: string
  readonly target: string
}

/** Whether one half of the cascade completed. */
export type CascadeHalfStatus = 'done' | 'failed'

/**
 * The cascade outcome as the journal will carry it. Declared here as well as
 * on `AccessEditInfo` so this module compiles both before and after the
 * journal side adds the field; the shapes are identical by contract.
 */
export interface CascadeOutcome {
  readonly agents: CascadeHalfStatus
  readonly groups: CascadeHalfStatus
}

export interface ServersRemoveDeps {
  readonly registry: Pick<RegistryStore, 'removeServer'>
  readonly agents: Pick<AgentsStore, 'listAgents' | 'ungrantServerEverywhere'>
  /** Group store port for the cascade and its interstitial (G6). */
  readonly groups: Pick<GroupsStore, 'listGroups' | 'ungrantServerEverywhere'>
  /** Receives an attributed record of each successful mutation. Optional. */
  readonly audit?: (event: ServerRemoveAuditEvent) => void
  /** Journal port for access changes (G6). Optional. */
  readonly journalAccessEdit?: (info: AccessEditInfo) => Promise<unknown>
  /**
   * Operator-facing diagnostic line sink, wired to the process's stderr by
   * `cli/ui-wiring.ts`. A handler must never reach for `process.stderr`
   * itself: what a UI mutation reports is the composition root's decision,
   * and a test needs to be able to read the line back.
   */
  readonly diagnostics?: (line: string) => void
}

/** One half's result: the names it dropped, and whether it got that far. */
interface HalfResult {
  readonly names: readonly string[]
  readonly status: CascadeHalfStatus
}

const HALF_FAILED: HalfResult = { names: [], status: 'failed' }

export function createServersRemoveHandler(deps: ServersRemoveDeps): UiHandler {
  function audit(ctx: UiRequestContext, action: string, target: string): void {
    deps.audit?.({ actor: 'ui', adminName: ctx.session?.adminName ?? '', action, target })
  }

  /** Runs one cascade half, containing its failure into a `'failed'` result. */
  async function runHalf(
    half: 'agents' | 'groups',
    server: string,
    drop: () => Promise<readonly string[]>,
  ): Promise<HalfResult> {
    try {
      return { names: await drop(), status: 'done' }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      deps.diagnostics?.(
        `[server.remove] "${server}" removed, but the ${half} cascade failed: ${reason}` +
          ' — repeat the removal to drop the dangling grants\n',
      )
      return HALF_FAILED
    }
  }

  /**
   * Records the cascade in the journal. The removal has already happened when
   * this runs, so a journal that cannot be reached must not turn a completed
   * removal into a 500: the injected writer never throws by contract
   * (`groups/journal-access-edit.ts` returns a drop indicator instead), and
   * this guard keeps that true for ANY injected port.
   */
  async function journalRemoval(
    ctx: UiRequestContext,
    server: string,
    agentsHalf: HalfResult,
    groupsHalf: HalfResult,
  ): Promise<void> {
    const write = deps.journalAccessEdit
    if (write === undefined) return
    const info: AccessEditInfo & { readonly cascade?: CascadeOutcome } = {
      actor: {
        adminName: ctx.session?.adminName ?? null,
        role: ctx.session?.role ?? null,
        via: 'ui',
      },
      action: 'server.remove',
      server,
      affectedAgents: agentsHalf.names,
      affectedGroups: groupsHalf.names,
      cascade: { agents: agentsHalf.status, groups: groupsHalf.status },
    }
    try {
      await write(info)
    } catch {
      // Deliberately contained, not swallowed silently: the audit sink above
      // already recorded the attributed removal, and the writer's own
      // diagnostics report the drop.
    }
  }

  /**
   * Removes a server and cascades: the same removal drops the server from
   * every personal grant and every group grant (owner decision G6). The
   * registry write goes FIRST — it is the source of truth, and a grant left
   * pointing at a gone server is today's tolerated state, while the reverse
   * is not. Three documents mean three independent CAS writes with no shared
   * transaction; a crash (or a failing half) leaves a dangling grant that
   * repeating the removal repairs.
   */
  return async function serversRemove(ctx: UiRequestContext): Promise<UiResult> {
    const fields = fieldsOf(ctx)
    const name = fields.name ?? ''
    if (fields.confirm !== 'true') {
      const interstitial = await removalInterstitial(deps, ctx, name)
      if (interstitial !== undefined) return interstitial
    }
    const result = await deps.registry.removeServer(name)
    if (result.status === 'not-found') {
      return { kind: 'response', status: HTTP_STATUS_NOT_FOUND, body: 'unknown server' }
    }
    const server = result.record.name
    const agentsHalf = await runHalf('agents', server, () => deps.agents.ungrantServerEverywhere(server))
    const groupsHalf = await runHalf('groups', server, () => deps.groups.ungrantServerEverywhere(server))
    audit(ctx, 'server.remove', server)
    await journalRemoval(ctx, server, agentsHalf, groupsHalf)
    return redirect('/servers')
  }
}

/**
 * The confirmation page, or `undefined` when nothing holds a grant and the
 * removal may proceed unchallenged.
 */
async function removalInterstitial(
  deps: ServersRemoveDeps,
  ctx: UiRequestContext,
  name: string,
): Promise<UiResult | undefined> {
  const [holders, holdingGroups] = await Promise.all([
    agentsGranting(deps.agents, name),
    groupsGranting(deps.groups, name),
  ])
  if (holders.length === 0 && holdingGroups.length === 0) return undefined
  const body = renderRemoveWarning({
    serverName: name,
    agents: holders,
    groups: holdingGroups,
    csrfToken: csrfTokenOf(ctx),
    currentAdmin: currentAdminOf(ctx),
  })
  return { kind: 'response', status: HTTP_STATUS_OK, body }
}

/** Names of the groups holding a grant for `serverName`, in store order. */
async function groupsGranting(
  groups: Pick<GroupsStore, 'listGroups'>,
  serverName: string,
): Promise<readonly string[]> {
  const all = await groups.listGroups()
  return all.filter((group) => Object.hasOwn(group.grants, serverName)).map((group) => group.name)
}

/**
 * Names of ACTIVE (non-revoked) agents holding a grant for `serverName` — the
 * set the interstitial lists, and therefore the set it counts. The cascade is
 * wider (it also drops revoked agents' dangling grants), which the page says
 * in words rather than folding into the number.
 */
async function agentsGranting(
  agents: Pick<AgentsStore, 'listAgents'>,
  serverName: string,
): Promise<readonly string[]> {
  const all = await agents.listAgents()
  return all
    .filter((agent) => agent.revokedAt === undefined && Object.hasOwn(agent.grants, serverName))
    .map((agent) => agent.name)
}
