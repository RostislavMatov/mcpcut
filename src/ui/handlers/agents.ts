import {
  AgentExistsError,
  AgentNotFoundError,
  InvalidAgentNameError,
  InvalidPromptPatternError,
  InvalidResourcePatternError,
  InvalidServerNameError,
  InvalidToolPatternError,
  type AgentsStore,
  type MethodGrantsInput,
} from '../../agents/store.js'
import type { UiSession } from '../auth.js'
import {
  BODY_FORBIDDEN,
  CONTENT_TYPE_HTML,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_OK,
} from '../constants.js'
import { renderAgentNotice, renderAgentsPage, renderAgentTokenOnce } from '../pages/agents.js'
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
  readonly audit?: UiAuditSink
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
 */
const AGENT_INPUT_ERRORS: readonly ErrorClass[] = [
  AgentExistsError,
  AgentNotFoundError,
  InvalidAgentNameError,
  InvalidServerNameError,
  InvalidToolPatternError,
  InvalidResourcePatternError,
  InvalidPromptPatternError,
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

/** Splits a whitespace/comma-separated pattern field into trimmed non-empty entries. */
function parseList(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Interprets one grant-dimension field: absent/empty → `undefined` (leave the
 * dimension unset, keeping the M3 fail-closed denial); a lone `*` → `'*'`;
 * otherwise the explicit pattern list.
 */
function parseGrantValue(value: string | undefined): '*' | string[] | undefined {
  const list = parseList(value)
  if (list.length === 0) return undefined
  if (list.length === 1 && list[0] === '*') return '*'
  return list
}

function methodGrantsFrom(form: Readonly<Record<string, string>>): MethodGrantsInput {
  const resources = parseGrantValue(form.resources)
  const prompts = parseGrantValue(form.prompts)
  return {
    ...(resources !== undefined ? { resources } : {}),
    ...(prompts !== undefined ? { prompts } : {}),
  }
}

export function createAgentsHandlers(deps: AgentsHandlersDeps): AgentsHandlers {
  const { agentsStore, audit } = deps

  function record(session: UiSession, action: string, target: string): void {
    audit?.({ actor: 'ui', adminName: session.adminName, action, target })
  }

  async function agentsPage(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    const agents = await agentsStore.listAgents()
    return htmlResult(HTTP_STATUS_OK, renderAgentsPage({ agents, session }))
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
      await agentsStore.grantServer(agent, server, tools, methodGrantsFrom(form))
      record(session, 'agents.grant', `${agent}/${server}`)
      return htmlResult(HTTP_STATUS_OK, renderAgentNotice({ message: `granted ${server} to ${agent}`, ok: true, session }))
    } catch (error) {
      return storeFailure(error, session)
    }
  }

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
      await agentsStore.ungrantServer(agent, server)
      record(session, 'agents.ungrant', `${agent}/${server}`)
      return htmlResult(HTTP_STATUS_OK, renderAgentNotice({ message: `removed ${server} from ${agent}`, ok: true, session }))
    } catch (error) {
      return storeFailure(error, session)
    }
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
      return htmlResult(HTTP_STATUS_OK, renderAgentNotice({ message: `revoked ${agent}`, ok: true, session }))
    } catch (error) {
      return storeFailure(error, session)
    }
  }

  return { agentsPage, agentsCreate, agentsGrant, agentsUngrant, agentsRevoke }
}
