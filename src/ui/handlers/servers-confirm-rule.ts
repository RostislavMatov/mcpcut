import { CONFIRM_AGENT_NAME_PATTERN, CONFIRM_ANY_AGENT, MAX_CONFIRM_AGENTS, RESERVED_OBJECT_KEYS, TOOL_RULE_NAME_PATTERN } from '../../policy/constants.js'
import type { PolicyFileWriteResult } from '../../policy/edit/policy-file.js'
import { applyConfirmInClientToDocument } from '../../policy/edit/set-confirm-in-client.js'
import type { UiSession } from '../auth.js'
import { roleSatisfies } from '../authz.js'
import { HTTP_STATUS_BAD_REQUEST, HTTP_STATUS_FORBIDDEN, HTTP_STATUS_OK } from '../constants.js'
import { CONFIRM_FIELD_VALUES, type ConfirmField } from '../pages/servers-confirm-rule.js'
import { headerValue, type UiHandler, type UiRequestContext, type UiResult } from '../routes.js'
import {
  decodeOnce,
  EXPECTED_HASH_FIELD,
  formAnswer,
  isRefusal,
  isValidServerName,
  jsonResult,
  loadTarget,
  recordPolicyEdit,
  refusal,
  wantsJson,
  writeRefusal,
  type PolicyEditJournalOutcome,
  type PolicyEditPorts,
  type Refusal,
} from './policy-edit-common.js'

/**
 * `POST /servers/:name/tools/:tool/confirm` (ADR-0019) — the sibling of the
 * admin-rule route (`servers-tool-rule.ts`) for the client-confirmation rule.
 * Owner-only by the `ROUTE_TABLE` row (re-checked here), with the same threat
 * model and the same plumbing (`policy-edit-common.ts`): the file is the one
 * this process loaded, both names are decoded once and validated before any
 * I/O, the write is compare-and-swap on `expected_hash`, a success is
 * journaled (`policy-edit`, `confirmInClient` beside `rule: null`) and audited
 * exactly once, a refusal does neither.
 *
 * Fields: `confirm` = `off` (removes only the EXACT key) | `all` (`["*"]`) |
 * `agents` (one or more repeated `agent` values, each a plain agent name —
 * `*` is the `all` button's job). The script posts JSON (`agent` a string or
 * an array), a native form posts urlencoded with repeated `agent`.
 */

export type ServersConfirmRuleDeps = PolicyEditPorts

export interface ServersConfirmRuleHandlers {
  readonly serversConfirmRule: UiHandler
}

const CONFIRM = 'confirm'
const AGENT = 'agent'
const AUDIT_ACTION = 'policy.confirm'
const WILDCARD_SUFFIX = '*'

interface ParsedRequest {
  readonly serverName: string
  readonly toolName: string
  readonly confirm: ConfirmField
  /** `null` = remove the exact key. */
  readonly agents: readonly string[] | null
  readonly expectedHash: string
}

function isExactToolName(name: string): boolean {
  return TOOL_RULE_NAME_PATTERN.test(name) && !name.endsWith(WILDCARD_SUFFIX) && !RESERVED_OBJECT_KEYS.includes(name)
}

function isConfirmField(value: string): value is ConfirmField {
  return (CONFIRM_FIELD_VALUES as readonly string[]).includes(value)
}

type RawFields = { readonly values: Readonly<Record<string, string>>; readonly agents: readonly unknown[] }

/** Body fields with `agent` kept repeated; untrusted, never throws. */
function rawFieldsOf(ctx: UiRequestContext): RawFields {
  const text = ctx.body.toString('utf8')
  const isJson = (headerValue(ctx.headers, 'content-type') ?? '').includes('application/json')
  if (!isJson) {
    const params = new URLSearchParams(text)
    return { values: Object.fromEntries(params), agents: params.getAll(AGENT) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { values: {}, agents: [] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { values: {}, agents: [] }
  const record = parsed as Record<string, unknown>
  const values = Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  const agent = Object.hasOwn(record, AGENT) ? record[AGENT] : undefined
  return { values, agents: Array.isArray(agent) ? agent : agent === undefined ? [] : [agent] }
}

function agentsOf(confirm: ConfirmField, raw: readonly unknown[]): readonly string[] | null | Refusal {
  if (confirm === 'off') return null
  if (confirm === 'all') return [CONFIRM_ANY_AGENT]
  const names = raw.filter((item): item is string => typeof item === 'string' && CONFIRM_AGENT_NAME_PATTERN.test(item))
  if (raw.length === 0 || names.length !== raw.length) {
    return refusal(HTTP_STATUS_BAD_REQUEST, {
      status: 'invalid',
      message: `"${CONFIRM}=agents" needs at least one "${AGENT}", each a plain agent name`,
    })
  }
  if (new Set(names).size > MAX_CONFIRM_AGENTS) {
    return refusal(HTTP_STATUS_BAD_REQUEST, { status: 'invalid', message: `at most ${MAX_CONFIRM_AGENTS} agents; use "all"` })
  }
  return names
}

/** Names from the path, fields from the body — every one validated before any I/O. */
function parseRequest(ctx: UiRequestContext): ParsedRequest | Refusal {
  const serverName = decodeOnce(ctx.params.name ?? '')
  const toolName = decodeOnce(ctx.params.tool ?? '')
  if (serverName === undefined || !isValidServerName(serverName)) {
    return refusal(HTTP_STATUS_BAD_REQUEST, { status: 'invalid', message: 'invalid server name' })
  }
  if (toolName === undefined || !isExactToolName(toolName)) {
    return refusal(HTTP_STATUS_BAD_REQUEST, { status: 'invalid', message: 'invalid tool name: a per-tool rule must be an exact name' })
  }
  const raw = rawFieldsOf(ctx)
  const confirm = raw.values[CONFIRM] ?? ''
  if (!isConfirmField(confirm)) {
    return refusal(HTTP_STATUS_BAD_REQUEST, {
      status: 'invalid',
      message: `"${CONFIRM}" must be one of ${CONFIRM_FIELD_VALUES.join(', ')}`,
    })
  }
  const expectedHash = raw.values[EXPECTED_HASH_FIELD] ?? ''
  if (expectedHash === '') {
    return refusal(HTTP_STATUS_BAD_REQUEST, { status: 'invalid', message: `"${EXPECTED_HASH_FIELD}" is required` })
  }
  const agents = agentsOf(confirm, raw.agents)
  if (agents !== null && isRefusal(agents)) return agents
  return { serverName, toolName, confirm, agents, expectedHash }
}

function editMessage(parsed: ParsedRequest): string {
  const target = `${parsed.serverName}/${parsed.toolName}`
  return parsed.agents === null ? `cleared the client confirmation for ${target}` : `set client confirmation (${parsed.confirm}) for ${target}`
}

export function createServersConfirmRuleHandlers(deps: ServersConfirmRuleDeps): ServersConfirmRuleHandlers {
  function recordEdit(
    session: UiSession,
    parsed: ParsedRequest,
    sourcePath: string,
    written: Extract<PolicyFileWriteResult, { status: 'written' }>,
  ): Promise<PolicyEditJournalOutcome> {
    return recordPolicyEdit(
      deps,
      session,
      { action: AUDIT_ACTION, target: `${parsed.serverName}/${parsed.toolName} ${parsed.confirm}` },
      {
        serverName: parsed.serverName,
        toolName: parsed.toolName,
        rule: null,
        confirmInClient: parsed.agents,
        policyHashBefore: written.hashBefore,
        policyHashAfter: written.hashAfter,
        sourcePath,
      },
    )
  }

  async function serversConfirmRule(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined || !roleSatisfies(session.role, 'owner')) {
      return jsonResult(HTTP_STATUS_FORBIDDEN, { status: 'forbidden', message: 'Owner role required.' })
    }
    const parsed = parseRequest(ctx)
    if (isRefusal(parsed)) return jsonResult(parsed.status, parsed.payload)

    const target = await loadTarget(deps)
    if (isRefusal(target)) return jsonResult(target.status, target.payload)

    const applied = applyConfirmInClientToDocument(target.read.document, parsed.serverName, parsed.toolName, parsed.agents)
    if (!applied.ok) return jsonResult(HTTP_STATUS_BAD_REQUEST, { status: 'invalid', message: applied.message })

    const written = await deps.writePolicyFile(target.path, applied.document, { expectedHash: parsed.expectedHash })
    if (written.status !== 'written') {
      const refused = writeRefusal(written)
      return jsonResult(refused.status, refused.payload)
    }

    // The file is on disk: attribute FIRST; nothing after may leave the edit unjournaled.
    const journal = await recordEdit(session, parsed, target.path, written)
    if (!wantsJson(ctx)) return formAnswer(session, editMessage(parsed), journal)
    return jsonResult(HTTP_STATUS_OK, {
      status: 'ok',
      server: parsed.serverName,
      tool: parsed.toolName,
      confirm: parsed.confirm,
      agents: parsed.agents,
      hashBefore: written.hashBefore,
      hashAfter: written.hashAfter,
      journal: journal.written ? 'written' : 'dropped',
    })
  }

  return { serversConfirmRule }
}
