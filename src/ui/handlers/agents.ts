import {
  AgentExistsError,
  AgentNotFoundError,
  InvalidAgentNameError,
  InvalidPromptPatternError,
  InvalidResourcePatternError,
  InvalidServerNameError,
  InvalidToolPatternError,
  type AgentsStore,
} from '../../agents/store.js'
import type { AgentGrant, AgentRecord } from '../../agents/schema.js'
import { effectiveGrantsOf } from '../../agents/effective.js'
import type { GroupRecord } from '../../groups/schema.js'
import type { GroupsStore } from '../../groups/store.js'
import type { AccessEditInfo } from '../../journal/record.js'
import { StoreWriteRejectedError } from '../../policy/store.js'
import type { UiSession } from '../auth.js'
import {
  BODY_FORBIDDEN,
  CONTENT_TYPE_HTML,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_OK,
} from '../constants.js'
import { renderAgentNotice, renderAgentsPage, renderAgentTokenOnce } from '../pages/agents.js'
import { renderUngrantConfirm } from '../pages/agents-ungrant.js'
import { methodGrantsFrom, parseGrantValue } from './grant-fields.js'
import { internalErrorResult, isKnownStoreError, type ErrorClass } from './store-errors.js'
import { headerValue, parseBodyFields, type UiHandler, type UiRequestContext, type UiResult } from '../routes.js'

/**
 * Action handlers for the agent permission matrix (M4 Task 14). Each handler is
 * a thin adapter: it parses the (untrusted) form body, calls the shared
 * `agents/store.ts` (which owns the cross-process lock, so a concurrent CLI
 * edit is never lost), and renders through `pages/agents.ts`. Known store
 * errors (missing agent, invalid name/pattern) become a readable 400 notice,
 * never a 500. The plaintext token from `create` is rendered ONCE in the action
 * response and is never written to the session, a log or a later page.
 */

/** One attribution record for a UI-originated mutation (`actor: 'ui'` + name). */
export interface UiAuditEvent {
  readonly actor: 'ui'
  readonly adminName: string
  readonly action: string
  readonly target: string
}

/** Optional attribution sink; the token is NEVER part of an audit event. */
export type UiAuditSink = (event: UiAuditEvent) => void

export interface AgentsHandlersDeps {
  readonly agentsStore: AgentsStore
  /**
   * Read side of the groups store. The page needs the whole list to derive
   * each agent's effective grants (M5.5 п.2, G2); nothing here writes groups —
   * membership is edited on `/groups` only.
   */
  readonly groups: Pick<GroupsStore, 'listGroups'>
  readonly audit?: UiAuditSink
  /**
   * Journal port for access changes (owner decision T1, 2026-09-01), injected
   * by `cli/ui-wiring.ts` — the same port and the same shape the group
   * handlers use, so "who changed this agent's surface" is answered by one
   * record category however the change was made. Optional: without it an edit
   * still happens and is still attributed on the audit sink, it simply leaves
   * no journal record.
   *
   * The one-time token of `createAgent` has NO field in `AccessEditInfo` and
   * must never acquire one: the record says an agent was created, never with
   * what key.
   */
  readonly journalAccessEdit?: (info: AccessEditInfo) => Promise<unknown>
}

export interface AgentsHandlers {
  readonly agentsPage: UiHandler
  readonly agentsCreate: UiHandler
  readonly agentsGrant: UiHandler
  readonly agentsUngrant: UiHandler
  readonly agentsRevoke: UiHandler
}

/** HTML response with an explicit status (server defaults the content type). */
function htmlResult(status: number, body: string): UiResult {
  return { kind: 'response', status, headers: { 'content-type': CONTENT_TYPE_HTML }, body }
}

/** Uniform 403 for the (server-guaranteed-impossible) missing-session case. */
const FORBIDDEN: UiResult = { kind: 'response', status: HTTP_STATUS_FORBIDDEN, body: BODY_FORBIDDEN }

function fields(ctx: UiRequestContext): Readonly<Record<string, string>> {
  return parseBodyFields(ctx.body, headerValue(ctx.headers, 'content-type'))
}

/**
 * Agent-store errors caused by what the operator typed. `AgentsFileInvalidError`
 * is deliberately ABSENT: a corrupt `agents.json` is a broken plane, not a bad
 * form, and must not be reported as the operator's mistake.
 *
 * `StoreWriteRejectedError` IS here: it is raised BEFORE the write when the
 * value would fail the document schema — a `MAX_*` cap reached, say — which is
 * a fact about what the operator asked for, not about a broken store.
 */
const AGENT_INPUT_ERRORS: readonly ErrorClass[] = [
  AgentExistsError,
  AgentNotFoundError,
  InvalidAgentNameError,
  InvalidServerNameError,
  InvalidToolPatternError,
  InvalidResourcePatternError,
  InvalidPromptPatternError,
  StoreWriteRejectedError,
]

/**
 * Renders a store failure: a known input fault as a readable 400 notice,
 * anything else as the detail-free 500 the server's catch-all would have given.
 */
function storeFailure(error: unknown, session: UiSession): UiResult {
  if (!isKnownStoreError(error, AGENT_INPUT_ERRORS)) return internalErrorResult()
  const message = error instanceof Error ? error.message : 'unexpected error'
  return htmlResult(HTTP_STATUS_BAD_REQUEST, renderAgentNotice({ message, ok: false, session }))
}

export function createAgentsHandlers(deps: AgentsHandlersDeps): AgentsHandlers {
  const { agentsStore, groups, audit } = deps

  function record(session: UiSession, action: string, target: string): void {
    audit?.({ actor: 'ui', adminName: session.adminName, action, target })
  }

  /**
   * Records one access change in the journal. The store write has already
   * happened when this runs, so a journal that cannot be reached must not turn
   * it into a 500: the injected writer never throws by contract
   * (`groups/journal-access-edit.ts` returns a drop indicator instead), and
   * this guard keeps that true for ANY injected port. Same shape and same
   * ordering as `handlers/groups.ts`: attribution first, journal second, both
   * exactly once.
   */
  async function journal(session: UiSession, info: Omit<AccessEditInfo, 'actor'>): Promise<void> {
    const write = deps.journalAccessEdit
    if (write === undefined) return
    try {
      await write({
        actor: { adminName: session.adminName, role: session.role, via: 'ui' },
        ...info,
      })
    } catch {
      // Deliberately contained, not swallowed silently: the audit sink above
      // already recorded the attributed edit, and the writer's own
      // diagnostics report the drop.
    }
  }

  async function agentsPage(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    const [agents, groupList] = await Promise.all([agentsStore.listAgents(), groups.listGroups()])
    return htmlResult(HTTP_STATUS_OK, renderAgentsPage({ agents, groups: groupList, session }))
  }

  async function agentsCreate(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    const name = fields(ctx).name?.trim() ?? ''
    if (name === '') {
      return htmlResult(HTTP_STATUS_BAD_REQUEST, renderAgentNotice({ message: 'agent name is required', ok: false, session }))
    }
    try {
      const created = await agentsStore.createAgent(name)
      record(session, 'agents.create', name)
      // `created.token` is deliberately NOT passed on: the record says the
      // agent exists, the reveal page is the only place the key is rendered.
      await journal(session, { action: 'agent.create', agent: created.agent.name })
      return htmlResult(HTTP_STATUS_OK, renderAgentTokenOnce({ agent: created.agent.name, token: created.token, session }))
    } catch (error) {
      return storeFailure(error, session)
    }
  }

  async function agentsGrant(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    const form = fields(ctx)
    const agent = form.agent?.trim() ?? ''
    const server = form.server?.trim() ?? ''
    if (agent === '' || server === '') {
      return htmlResult(HTTP_STATUS_BAD_REQUEST, renderAgentNotice({ message: 'agent and server are required', ok: false, session }))
    }
    const toolsValue = parseGrantValue(form.tools)
    const tools = toolsValue === undefined ? [] : toolsValue
    try {
      const updated = await agentsStore.grantServer(agent, server, tools, methodGrantsFrom(form))
      record(session, 'agents.grant', `${agent}/${server}`)
      const grant = updated.grants[server]
      await journal(session, {
        action: 'agent.grant',
        agent,
        server,
        ...(grant !== undefined ? { grant } : {}),
      })
      return htmlResult(HTTP_STATUS_OK, renderAgentNotice({ message: `granted ${server} to ${agent}`, ok: true, session }))
    } catch (error) {
      return storeFailure(error, session)
    }
  }

  /**
   * Removing a PERSONAL grant that shadows a group grant widens effective
   * access instead of narrowing it (ADR-0010 §2), so it is confirmed first
   * (U1) and, once confirmed, attributed as what it is: the audit target
   * names the groups the agent falls back to, so the sink line cannot be read
   * as plain de-escalation.
   */
  async function agentsUngrant(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    const form = fields(ctx)
    const agent = form.agent?.trim() ?? ''
    const server = form.server?.trim() ?? ''
    if (agent === '' || server === '') {
      return htmlResult(HTTP_STATUS_BAD_REQUEST, renderAgentNotice({ message: 'agent and server are required', ok: false, session }))
    }
    try {
      const shadowed = await shadowedFallback(agent, server)
      if (shadowed !== undefined && form.confirm !== 'true') {
        return htmlResult(
          HTTP_STATUS_OK,
          renderUngrantConfirm({ agent, server, groups: shadowed.groups, fallback: shadowed.grant, session }),
        )
      }
      await agentsStore.ungrantServer(agent, server)
      record(session, 'agents.ungrant', ungrantTarget(agent, server, shadowed?.groups))
      await journal(session, { action: 'agent.ungrant', agent, server })
      return htmlResult(HTTP_STATUS_OK, renderAgentNotice({ message: `removed ${server} from ${agent}`, ok: true, session }))
    } catch (error) {
      return storeFailure(error, session)
    }
  }

  /**
   * The group grant `agent` would fall back to if its personal grant for
   * `server` were removed, or `undefined` when the removal is a plain
   * narrowing (no personal grant, no membership, or no group granting it).
   *
   * The fallback is not recomputed by hand: the record is re-resolved WITHOUT
   * the server, so whatever `effectiveGrantsOf` would then hand the traffic
   * path is exactly what the panel shows — one merge rule, not two.
   */
  async function shadowedFallback(
    agent: string,
    server: string,
  ): Promise<{ readonly groups: readonly string[]; readonly grant: AgentGrant } | undefined> {
    const record = await agentsStore.getAgent(agent)
    if (record === undefined) return undefined
    const groupList = await groups.listGroups()
    const source = effectiveGrantsOf(record, groupList).sources[server]
    if (source?.kind !== 'agent' || source.shadowedGroups.length === 0) return undefined
    return fallbackAfterRemoval(record, groupList, server)
  }

  async function agentsRevoke(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    const agent = fields(ctx).agent?.trim() ?? ''
    if (agent === '') {
      return htmlResult(HTTP_STATUS_BAD_REQUEST, renderAgentNotice({ message: 'agent is required', ok: false, session }))
    }
    try {
      await agentsStore.revokeAgent(agent)
      record(session, 'agents.revoke', agent)
      await journal(session, { action: 'agent.revoke', agent })
      return htmlResult(HTTP_STATUS_OK, renderAgentNotice({ message: `revoked ${agent}`, ok: true, session }))
    } catch (error) {
      return storeFailure(error, session)
    }
  }

  return { agentsPage, agentsCreate, agentsGrant, agentsUngrant, agentsRevoke }
}

/** The audit target: plain, or annotated with what the agent now inherits. */
function ungrantTarget(agent: string, server: string, groups: readonly string[] | undefined): string {
  const target = `${agent}/${server}`
  if (groups === undefined || groups.length === 0) return target
  return `${target} (inherits ${groups.map((name) => `group:${name}`).join(', ')})`
}

/** The record as it would be with `server` dropped from its personal grants. */
function withoutServer(record: AgentRecord, server: string): AgentRecord {
  const grants = Object.fromEntries(Object.entries(record.grants).filter(([name]) => name !== server))
  return { ...record, grants }
}

/** Re-resolves the agent without the personal grant and reads the inherited one back. */
function fallbackAfterRemoval(
  record: AgentRecord,
  groupList: readonly GroupRecord[],
  server: string,
): { readonly groups: readonly string[]; readonly grant: AgentGrant } | undefined {
  const after = effectiveGrantsOf(withoutServer(record, server), groupList)
  const source = after.sources[server]
  const grant = after.grants[server]
  if (source?.kind !== 'group' || grant === undefined) return undefined
  return { groups: source.groups, grant }
}
