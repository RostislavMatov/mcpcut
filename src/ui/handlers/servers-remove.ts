import { GRANT_SERVER_NAME_PATTERN } from '../../agents/constants.js'
import type { AgentsStore } from '../../agents/store.js'
import type { GroupsStore } from '../../groups/store.js'
import type { CascadeHalfStatus } from '../../journal/access-edit-record.js'
import { RESERVED_OBJECT_KEYS } from '../../policy/constants.js'
import type { RegistryStore } from '../../registry/store.js'
import { HTTP_STATUS_NOT_FOUND, HTTP_STATUS_OK } from '../constants.js'
import { renderPruneDangling, renderRemoveWarning } from '../pages/servers-holders.js'
import type { UiHandler, UiRequestContext, UiResult } from '../routes.js'
import type { AccessEditJournalPort } from './agents.js'
import { csrfTokenOf, currentAdminOf, fieldsOf } from './request-helpers.js'
import { journalServerChange, serverChangeApplied } from './servers-journal.js'

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
 *
 * The `not-found` branch is a REPAIR OFFER, not a repair (owner decision T5,
 * 2026-09-01). A name the registry no longer knows may still be granted, and a
 * bare 404 would leave the browser with no way to prune what a crashed cascade
 * left behind — but "remove" must not silently mean "rewrite two other
 * documents" either. So an unregistered name that still dangles gets an
 * interstitial naming what holds it, and only its explicit `prune=true` runs
 * the cascade. An unregistered name that dangles nowhere is the 404 of before.
 */

/** One attributed UI mutation, for the audit sink. */
export interface ServerRemoveAuditEvent {
  readonly actor: 'ui'
  readonly adminName: string
  readonly action: string
  readonly target: string
}

export interface ServersRemoveDeps {
  /**
   * `listServers` is read BEFORE anything is written, to tell "remove this
   * registration" from "prune what a removal left behind" (T5) without the
   * removal itself being the question.
   */
  readonly registry: Pick<RegistryStore, 'removeServer' | 'listServers'>
  readonly agents: Pick<AgentsStore, 'listAgents' | 'ungrantServerEverywhere'>
  /** Group store port for the cascade and its interstitial (G6). */
  readonly groups: Pick<GroupsStore, 'listGroups' | 'ungrantServerEverywhere'>
  /** Receives an attributed record of each successful mutation. Optional. */
  readonly audit?: (event: ServerRemoveAuditEvent) => void
  /** Journal port for access changes (G6). Optional. */
  readonly journalAccessEdit?: AccessEditJournalPort
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

  /** Both cascade halves, plus the audit line and the journal record. */
  async function cascade(ctx: UiRequestContext, server: string): Promise<UiResult> {
    const agentsHalf = await runHalf('agents', server, () => deps.agents.ungrantServerEverywhere(server))
    const groupsHalf = await runHalf('groups', server, () => deps.groups.ungrantServerEverywhere(server))
    audit(ctx, 'server.remove', server)
    // The removal has already happened: the shared journal half contains a
    // failing port and puts a dropped record on the success page (audit F1).
    const journal = await journalServerChange(deps.journalAccessEdit, ctx, {
      action: 'server.remove',
      server,
      affectedAgents: agentsHalf.names,
      affectedGroups: groupsHalf.names,
      cascade: { agents: agentsHalf.status, groups: groupsHalf.status },
    })
    return serverChangeApplied(ctx, `removed ${server}`, journal)
  }

  /**
   * The repair offer for a name the registry does not hold (T5). Nothing is
   * written unless the operator came back with `prune=true`: a mistyped name
   * that happens to match an old grant must not rewrite `agents.json` and
   * `groups.json` on the strength of a single POST.
   */
  async function pruneDangling(ctx: UiRequestContext, name: string, prune: boolean): Promise<UiResult> {
    if (!canDangle(name)) return NOT_FOUND
    const [holders, holdingGroups] = await Promise.all([
      agentsNamingServer(deps.agents, name),
      groupsGranting(deps.groups, name),
    ])
    if (holders.length === 0 && holdingGroups.length === 0) return NOT_FOUND
    if (!prune) {
      const body = renderPruneDangling({
        serverName: name,
        agents: holders,
        groups: holdingGroups,
        csrfToken: csrfTokenOf(ctx),
        currentAdmin: currentAdminOf(ctx),
      })
      return { kind: 'response', status: HTTP_STATUS_OK, body }
    }
    return cascade(ctx, name)
  }

  /**
   * Removes a server and cascades: the same removal drops the server from
   * every personal grant and every group grant (owner decision G6). The
   * registry write goes FIRST — it is the source of truth, and a grant left
   * pointing at a gone server is today's tolerated state, while the reverse
   * is not. Three documents mean three independent CAS writes with no shared
   * transaction; a crash (or a failing half) leaves a dangling grant that the
   * prune offer above repairs.
   */
  return async function serversRemove(ctx: UiRequestContext): Promise<UiResult> {
    const fields = fieldsOf(ctx)
    const name = fields.name ?? ''
    if (!(await isRegistered(deps.registry, name))) {
      return pruneDangling(ctx, name, fields.prune === 'true')
    }
    if (fields.confirm !== 'true') {
      const interstitial = await removalInterstitial(deps, ctx, name)
      if (interstitial !== undefined) return interstitial
    }
    const result = await deps.registry.removeServer(name)
    // Lost the race with a concurrent removal: nothing was removed here, so
    // nothing is audited, journalled or pruned on this request's account.
    if (result.status === 'not-found') return NOT_FOUND
    return cascade(ctx, result.record.name)
  }
}

/** Whether the registry still holds a record under exactly this name. */
async function isRegistered(
  registry: Pick<RegistryStore, 'listServers'>,
  name: string,
): Promise<boolean> {
  const all = await registry.listServers()
  return all.some((record) => record.name === name)
}

/** The 404 for a name that is neither registered nor granted anywhere. */
const NOT_FOUND: UiResult = {
  kind: 'response',
  status: HTTP_STATUS_NOT_FOUND,
  body: 'unknown server',
}

/**
 * Whether `name` could be a grant key at all. A name outside the grant shape,
 * or a reserved object key every store refuses, can never appear in
 * `agents.json` or `groups.json` — asking would only raise
 * `InvalidServerNameError` and emit a "repeat the removal" diagnostic the
 * operator can never satisfy. Same guard as `cli/server-remove-cascade.ts`.
 */
function canDangle(name: string): boolean {
  return GRANT_SERVER_NAME_PATTERN.test(name) && !RESERVED_OBJECT_KEYS.includes(name)
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
export async function groupsGranting(
  groups: Pick<GroupsStore, 'listGroups'>,
  serverName: string,
): Promise<readonly string[]> {
  const all = await groups.listGroups()
  return all.filter((group) => Object.hasOwn(group.grants, serverName)).map((group) => group.name)
}

/**
 * Names of EVERY agent whose grants name `serverName`, revoked ones included —
 * exactly the set `ungrantServerEverywhere` would prune, which is what the T5
 * prune offer has to count and list.
 */
export async function agentsNamingServer(
  agents: Pick<AgentsStore, 'listAgents'>,
  serverName: string,
): Promise<readonly string[]> {
  const all = await agents.listAgents()
  return all.filter((agent) => Object.hasOwn(agent.grants, serverName)).map((agent) => agent.name)
}

/**
 * Names of ACTIVE (non-revoked) agents holding a grant for `serverName` — the
 * set the removal interstitial lists, and therefore the set it counts. The
 * cascade is wider (it also drops revoked agents' dangling grants), which the
 * page says in words rather than folding into the number.
 *
 * The same set answers the `server add` callout (T3): a revoked agent's token
 * is dead, so it is not a live grantee of a name being re-registered.
 */
export async function agentsGranting(
  agents: Pick<AgentsStore, 'listAgents'>,
  serverName: string,
): Promise<readonly string[]> {
  const all = await agents.listAgents()
  return all
    .filter((agent) => agent.revokedAt === undefined && Object.hasOwn(agent.grants, serverName))
    .map((agent) => agent.name)
}
