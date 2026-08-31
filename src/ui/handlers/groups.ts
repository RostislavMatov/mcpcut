import {
  InvalidAgentNameError,
  InvalidPromptPatternError,
  InvalidResourcePatternError,
  InvalidServerNameError,
  InvalidToolPatternError,
  type AgentsStore,
  type MethodGrantsInput,
} from '../../agents/store.js'
import {
  GroupExistsError,
  GroupNotFoundError,
  InvalidGroupNameError,
  type GroupsStore,
} from '../../groups/store.js'
import type { GroupRecord } from '../../groups/schema.js'
import type { AccessEditInfo } from '../../journal/record.js'
import { StoreWriteRejectedError } from '../../policy/store.js'
import type { RegistryStore } from '../../registry/store.js'
import type { UiSession } from '../auth.js'
import {
  BODY_FORBIDDEN,
  CONTENT_TYPE_HTML,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_OK,
  HTTP_STATUS_SEE_OTHER,
} from '../constants.js'
import {
  renderGroupRemoveConfirm,
  renderGroupRemoveRefusal,
  renderGroupsPage,
  type GroupDrawerId,
} from '../pages/groups.js'
import { renderNotice } from '../pages/notice.js'
import { headerValue, parseBodyFields, type UiHandler, type UiRequestContext, type UiResult } from '../routes.js'
import type { UiAuditSink } from './agents.js'
import { internalErrorResult, isKnownStoreError, type ErrorClass } from './store-errors.js'

/**
 * Action handlers for `/groups` (M5.5 п.2, decision G4: `viewer` reads, only
 * `owner` writes — the route table is the enforcement, this file assumes it).
 *
 * Each POST is a thin adapter over `groups/store.ts`, in one fixed order:
 * parse the untrusted body → refuse missing fields → check the things the
 * store deliberately does NOT check (that the server is in the registry, that
 * the agent exists and is not revoked — same division of labour as the CLI) →
 * write → attribute on the audit sink → journal the access change → 303 back
 * to the page. Attribution comes before the journal and both run exactly once,
 * mirroring `servers-tool-rule.ts`; a journal that cannot be reached must
 * never turn a completed write into a 500.
 */

export interface GroupsHandlersDeps {
  readonly groups: GroupsStore
  /** Read side of the agents store: member badges, the join drawer, existence. */
  readonly agents: Pick<AgentsStore, 'listAgents' | 'getAgent'>
  /** Read side of the registry: the grant drawer's options and existence. */
  readonly registry: Pick<RegistryStore, 'listServers' | 'getServer'>
  /** Receives an attributed record of each successful mutation. Optional. */
  readonly audit?: UiAuditSink
  /**
   * Journal port for access changes (G6/G4), injected by `cli/ui-wiring.ts`.
   * Optional: without it an edit still happens and is still attributed on the
   * audit sink, it simply leaves no journal record.
   */
  readonly journalAccessEdit?: (info: AccessEditInfo) => Promise<unknown>
}

export interface GroupsHandlers {
  readonly groupsPage: UiHandler
  readonly groupsCreate: UiHandler
  readonly groupsRemove: UiHandler
  readonly groupsGrant: UiHandler
  readonly groupsUngrant: UiHandler
  readonly groupsJoin: UiHandler
  readonly groupsLeave: UiHandler
}

/** HTML response with an explicit status (server defaults the content type). */
function htmlResult(status: number, body: string): UiResult {
  return { kind: 'response', status, headers: { 'content-type': CONTENT_TYPE_HTML }, body }
}

/** Uniform 403 for the (server-guaranteed-impossible) missing-session case. */
const FORBIDDEN: UiResult = { kind: 'response', status: HTTP_STATUS_FORBIDDEN, body: BODY_FORBIDDEN }

function fieldsOf(ctx: UiRequestContext): Readonly<Record<string, string>> {
  return parseBodyFields(ctx.body, headerValue(ctx.headers, 'content-type'))
}

function redirect(location: string): UiResult {
  return { kind: 'response', status: HTTP_STATUS_SEE_OTHER, headers: { location } }
}

/** A readable refusal: 400 with the reason and a way back to `/groups`. */
function refusal(message: string, session: UiSession): UiResult {
  return htmlResult(
    HTTP_STATUS_BAD_REQUEST,
    renderNotice({
      title: 'Groups — error',
      message,
      ok: false,
      backHref: '/groups',
      backLabel: 'Back to groups',
      session,
    }),
  )
}

/**
 * Store errors caused by what the operator typed. `GroupsFileInvalidError` is
 * deliberately ABSENT for the same reason `AgentsFileInvalidError` is absent
 * from the agents list: a corrupt document is a broken plane, not a bad form.
 * `StoreWriteRejectedError` IS present: a write refused against the document
 * schema (a `MAX_*` cap) is what the operator asked for, not a broken store.
 */
const GROUP_INPUT_ERRORS: readonly ErrorClass[] = [
  GroupExistsError,
  GroupNotFoundError,
  InvalidGroupNameError,
  InvalidAgentNameError,
  InvalidServerNameError,
  InvalidToolPatternError,
  InvalidResourcePatternError,
  InvalidPromptPatternError,
  StoreWriteRejectedError,
]

function storeFailure(error: unknown, session: UiSession): UiResult {
  if (!isKnownStoreError(error, GROUP_INPUT_ERRORS)) return internalErrorResult()
  return refusal(error instanceof Error ? error.message : 'unexpected error', session)
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
 * Interprets one grant-dimension field exactly as the agents grant does:
 * absent/empty → `undefined` (leave the dimension unset, keeping the M3
 * fail-closed denial); a lone `*` → `'*'`; otherwise the explicit list.
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

/** Which drawer a `?add=1` / `?grant=1` / `?join=1` asked to open, if any. */
function drawerFromQuery(query: URLSearchParams): GroupDrawerId | undefined {
  if (query.get('add') !== null) return 'create-group'
  if (query.get('grant') !== null) return 'grant-group'
  if (query.get('join') !== null) return 'join-group'
  return undefined
}

export function createGroupsHandlers(deps: GroupsHandlersDeps): GroupsHandlers {
  const { groups, agents, registry } = deps

  function audit(session: UiSession, action: string, target: string): void {
    deps.audit?.({ actor: 'ui', adminName: session.adminName, action, target })
  }

  /**
   * Records one access change in the journal. The write has already happened
   * when this runs, so a journal that cannot be reached must not turn it into
   * a 500: the injected writer never throws by contract
   * (`groups/journal-access-edit.ts` returns a drop indicator instead), and
   * this guard keeps that true for ANY injected port.
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

  async function groupsPage(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    const [groupList, agentList, servers] = await Promise.all([
      groups.listGroups(),
      agents.listAgents(),
      registry.listServers(),
    ])
    const canManage = session.role === 'owner'
    const drawer = canManage ? drawerFromQuery(ctx.query) : undefined
    const query = ctx.query.get('q') ?? ''
    return htmlResult(
      HTTP_STATUS_OK,
      renderGroupsPage({
        groups: groupList,
        agents: agentList,
        servers,
        session,
        canManage,
        ...(drawer !== undefined ? { drawer } : {}),
        ...(query !== '' ? { query } : {}),
      }),
    )
  }

  async function groupsCreate(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    const name = fieldsOf(ctx).name?.trim() ?? ''
    if (name === '') return refusal('group name is required', session)
    try {
      await groups.createGroup(name)
    } catch (error) {
      return storeFailure(error, session)
    }
    audit(session, 'group.create', name)
    await journal(session, { action: 'group.create', group: name })
    return redirect('/groups')
  }

  /**
   * Removes a group, but only after the operator has seen what it grants — and
   * never while somebody still inherits from it (G3). The membership refusal is
   * a 200 panel, not an error: it is the store's answer, not a failure.
   */
  async function groupsRemove(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    const form = fieldsOf(ctx)
    const name = form.name?.trim() ?? ''
    if (name === '') return refusal('group name is required', session)
    const record = await groups.getGroup(name)
    if (record === undefined) {
      return { kind: 'response', status: HTTP_STATUS_NOT_FOUND, body: 'unknown group' }
    }
    if (record.members.length > 0) {
      return htmlResult(HTTP_STATUS_OK, renderGroupRemoveRefusal({ group: record, session }))
    }
    if (form.confirm !== 'true') {
      return htmlResult(HTTP_STATUS_OK, renderGroupRemoveConfirm({ group: record, session }))
    }
    const result = await groups.removeGroup(name)
    if (result.status === 'not-found') {
      return { kind: 'response', status: HTTP_STATUS_NOT_FOUND, body: 'unknown group' }
    }
    if (result.status === 'has-members') {
      // Lost the race with a concurrent `group join`: the same refusal, built
      // from the membership the store actually saw.
      const fresh: GroupRecord = { ...record, members: [...result.members] }
      return htmlResult(HTTP_STATUS_OK, renderGroupRemoveRefusal({ group: fresh, session }))
    }
    audit(session, 'group.remove', name)
    await journal(session, { action: 'group.remove', group: name })
    return redirect('/groups')
  }

  async function groupsGrant(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    const form = fieldsOf(ctx)
    const group = form.group?.trim() ?? ''
    const server = form.server?.trim() ?? ''
    if (group === '' || server === '') return refusal('group and server are required', session)
    // The store deliberately does not know the registry (`agents/constants.ts`
    // states the same rule for personal grants), so granting a server that was
    // never registered is caught here rather than stored as a dangling name.
    if ((await registry.getServer(server)) === undefined) {
      return refusal(`unknown server "${server}"`, session)
    }
    const toolsValue = parseGrantValue(form.tools)
    const tools = toolsValue === undefined ? [] : toolsValue
    let record: GroupRecord
    try {
      record = await groups.grantServer(group, server, tools, methodGrantsFrom(form))
    } catch (error) {
      return storeFailure(error, session)
    }
    audit(session, 'group.grant', `${group}/${server}`)
    const grant = record.grants[server]
    await journal(session, {
      action: 'group.grant',
      group,
      server,
      ...(grant !== undefined ? { grant } : {}),
    })
    return redirect('/groups')
  }

  async function groupsUngrant(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    const form = fieldsOf(ctx)
    const group = form.group?.trim() ?? ''
    const server = form.server?.trim() ?? ''
    if (group === '' || server === '') return refusal('group and server are required', session)
    try {
      await groups.ungrantServer(group, server)
    } catch (error) {
      return storeFailure(error, session)
    }
    audit(session, 'group.ungrant', `${group}/${server}`)
    await journal(session, { action: 'group.ungrant', group, server })
    return redirect('/groups')
  }

  async function groupsJoin(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    const form = fieldsOf(ctx)
    const group = form.group?.trim() ?? ''
    const agentName = form.agent?.trim() ?? ''
    if (group === '' || agentName === '') return refusal('group and agent are required', session)
    const agent = await agents.getAgent(agentName)
    if (agent === undefined) return refusal(`unknown agent "${agentName}"`, session)
    // A revoked agent must not be handed access back through a group: the
    // revoke is the only thing standing between a leaked token and the plane.
    if (agent.revokedAt !== undefined) {
      return refusal(`agent "${agentName}" is revoked and cannot join a group`, session)
    }
    try {
      await groups.addMember(group, agentName)
    } catch (error) {
      return storeFailure(error, session)
    }
    audit(session, 'group.join', `${group}/${agentName}`)
    await journal(session, { action: 'group.join', group, agent: agentName })
    return redirect('/groups')
  }

  async function groupsLeave(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    const form = fieldsOf(ctx)
    const group = form.group?.trim() ?? ''
    const agentName = form.agent?.trim() ?? ''
    if (group === '' || agentName === '') return refusal('group and agent are required', session)
    try {
      await groups.removeMember(group, agentName)
    } catch (error) {
      return storeFailure(error, session)
    }
    audit(session, 'group.leave', `${group}/${agentName}`)
    await journal(session, { action: 'group.leave', group, agent: agentName })
    return redirect('/groups')
  }

  return { groupsPage, groupsCreate, groupsRemove, groupsGrant, groupsUngrant, groupsJoin, groupsLeave }
}
