import type { PolicyEditInfo } from '../../journal/policy-edit-record.js'
import { RESERVED_OBJECT_KEYS, TOOL_RULE_NAME_PATTERN } from '../../policy/constants.js'
import type { JournalPolicyEditOutcome } from '../../policy/edit/journal-edit.js'
import type { PolicyFileReadResult, PolicyFileWriteResult, WritePolicyFileOptions } from '../../policy/edit/policy-file.js'
import { applyToolRuleToDocument } from '../../policy/edit/set-tool-rule.js'
import type { PolicyEditTarget } from '../../policy/edit/write-target.js'
import { effectiveToolRule } from '../../policy/effective.js'
import { DEFAULT_INVENTORY_STORE, type InventoryStoreData } from '../../policy/inventory-store.js'
import { SERVER_NAME_PATTERN, type PolicyOutcome } from '../../policy/schema.js'
import type { UiSession } from '../auth.js'
import { roleSatisfies } from '../authz.js'
import {
  AUDIT_RECORD_DROPPED_WARNING,
  CONTENT_TYPE_HTML,
  CONTENT_TYPE_JSON,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_CONFLICT,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_INTERNAL_ERROR,
  HTTP_STATUS_OK,
  HTTP_STATUS_SEE_OTHER,
} from '../constants.js'
import { renderNotice } from '../pages/notice.js'
import { quarantineStateOf, TOOL_RULE_FIELD_VALUES, type ToolRuleField } from '../pages/servers-tool-rule.js'
import { headerValue, parseBodyFields, type UiHandler, type UiRequestContext, type UiResult } from '../routes.js'
import type { UiAuditEvent } from './servers.js'

/**
 * `POST /servers/:name/tools/:tool/rule` (plan policy-tool-rules-ui §6,
 * ADR-0009) — the ONE HTTP path that writes `policy.json`. Owner-only by the
 * `ROUTE_TABLE` row (and re-checked here). The threat model of writing a
 * security boundary from a browser request, and how each item is met:
 *
 *  - the PATH is fixed by the composition root (`resolveEditTarget`): the
 *    file this process itself loaded (correction 2026-08-26 — see ADR-0009,
 *    "Поправка 2026-08-26"); no field of the request is ever a file path;
 *  - both names are percent-decoded exactly once and validated against the
 *    schema's own patterns (`SERVER_NAME_PATTERN`, exact
 *    `TOOL_RULE_NAME_PATTERN`) before anything is read;
 *  - the write is compare-and-swap on the `policyHashOf` the page rendered
 *    with (`expected_hash`) — a file that moved on since yields 409, never a
 *    lost update (finding 6);
 *  - who ELSE reads that file is DISPLAYED by the card, never a refusal: an
 *    edit always reaches the entry points that loaded the file it changes;
 *  - no policy on disk is never turned into one (O4); an invalid file is a
 *    409 with its errors, never a write target (O3);
 *  - a success is journaled (`kind: 'policy-edit'`, `via: 'ui'`) and audited
 *    exactly once, after the file is on disk; no refusal does either.
 *
 * A JSON request (the client script) gets a JSON result; a plain form POST
 * gets a 303 back to `/servers` on success (the no-JS contract). Refusals
 * are always JSON — small, and the script surfaces the status.
 *
 * A success whose journal record was DROPPED (security audit 2026-09-02, F1)
 * is still a success — the rule is live — but says so: the JSON carries
 * `journal: 'dropped'`, and the form path answers with a notice page bearing
 * the warning line instead of the redirect, which has nowhere to say it.
 */

/**
 * What the handler learns from the journal port: whether the record landed
 * (`policy/edit/journal-edit.ts` also counts the drops; the handler needs the
 * verdict, honestly typed rather than widened to `unknown`).
 */
export type PolicyEditJournalOutcome = Pick<JournalPolicyEditOutcome, 'written'>

/** The `journal` field of the JSON success payload. */
type JournalRecordState = 'written' | 'dropped'

export interface ServersToolRuleDeps {
  /** The file THIS process loaded its policy from — bound by the composition root, never by a request. */
  readonly resolveEditTarget: () => Promise<PolicyEditTarget>
  readonly readPolicyFile: (path: string) => Promise<PolicyFileReadResult>
  readonly writePolicyFile: (
    path: string,
    document: unknown,
    options: WritePolicyFileOptions,
  ) => Promise<PolicyFileWriteResult>
  /** Read port for the inventory; the effective outcome after an edit honors quarantine through it. */
  readonly readInventory?: () => Promise<InventoryStoreData>
  /** The journal sink for the edit record; must not throw (the file is already written) and answers whether the record landed. */
  readonly journal: (edit: PolicyEditInfo) => Promise<PolicyEditJournalOutcome>
  /** Attribution line sink, as every other UI mutation. */
  readonly audit?: (event: UiAuditEvent) => void
}

export interface ServersToolRuleHandlers {
  readonly serversToolRule: UiHandler
}

/** Body field names of the rule form (`pages/servers-tool-rule.ts` renders them). */
const RULE_FIELD = 'rule'
const EXPECTED_HASH_FIELD = 'expected_hash'
const AUDIT_ACTION = 'policy.set'
const WILDCARD_SUFFIX = '*'

type Refusal = { readonly status: number; readonly payload: Record<string, unknown> }

interface ParsedRequest {
  readonly serverName: string
  readonly toolName: string
  readonly rule: PolicyOutcome | null
  readonly ruleField: ToolRuleField
  readonly expectedHash: string
}

function jsonResult(status: number, payload: unknown): UiResult {
  return {
    kind: 'response',
    status,
    headers: { 'content-type': CONTENT_TYPE_JSON },
    body: Buffer.from(JSON.stringify(payload), 'utf8'),
  }
}

function refusal(status: number, payload: Record<string, unknown>): Refusal {
  return { status, payload }
}

/** Exactly one decode; a malformed escape is `undefined`, never a throw. */
function decodeOnce(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

function isValidServerName(name: string): boolean {
  return SERVER_NAME_PATTERN.test(name) && !RESERVED_OBJECT_KEYS.includes(name)
}

function isExactToolName(name: string): boolean {
  return TOOL_RULE_NAME_PATTERN.test(name) && !name.endsWith(WILDCARD_SUFFIX) && !RESERVED_OBJECT_KEYS.includes(name)
}

function isRuleField(value: string): value is ToolRuleField {
  return (TOOL_RULE_FIELD_VALUES as readonly string[]).includes(value)
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
  const fields = parseBodyFields(ctx.body, headerValue(ctx.headers, 'content-type'))
  const ruleField = fields[RULE_FIELD] ?? ''
  if (!isRuleField(ruleField)) {
    return refusal(HTTP_STATUS_BAD_REQUEST, {
      status: 'invalid',
      message: `"${RULE_FIELD}" must be one of ${TOOL_RULE_FIELD_VALUES.join(', ')}`,
    })
  }
  const expectedHash = fields[EXPECTED_HASH_FIELD] ?? ''
  if (expectedHash === '') {
    return refusal(HTTP_STATUS_BAD_REQUEST, { status: 'invalid', message: `"${EXPECTED_HASH_FIELD}" is required` })
  }
  return { serverName, toolName, rule: ruleField === 'clear' ? null : ruleField, ruleField, expectedHash }
}

function isRefusal<T extends object>(value: T | Refusal): value is Refusal {
  return 'payload' in value
}

/** JSON callers (the client script posts JSON) get JSON; a native form gets the redirect. */
function wantsJson(ctx: UiRequestContext): boolean {
  const contentType = headerValue(ctx.headers, 'content-type') ?? ''
  const accept = headerValue(ctx.headers, 'accept') ?? ''
  return contentType.includes('application/json') || accept.includes('application/json')
}

/** The file this process loaded, read for edit; refusable before an edit is even computed. */
async function loadTarget(
  deps: ServersToolRuleDeps,
): Promise<{ readonly path: string; readonly read: Extract<PolicyFileReadResult, { status: 'loaded' }> } | Refusal> {
  const target = await deps.resolveEditTarget()
  const read = await deps.readPolicyFile(target.path)
  if (read.status === 'absent') {
    return refusal(HTTP_STATUS_CONFLICT, { status: 'no-policy', message: 'no policy — enforcement off; nothing to edit' })
  }
  if (read.status === 'error') {
    return refusal(HTTP_STATUS_CONFLICT, {
      status: 'invalid-policy',
      message: 'the policy file on disk is invalid; fix it by hand before editing here',
      errors: read.errors,
    })
  }
  return { path: target.path, read }
}

function writeRefusal(written: Exclude<PolicyFileWriteResult, { status: 'written' }>): Refusal {
  if (written.status === 'conflict') {
    return refusal(HTTP_STATUS_CONFLICT, { status: 'conflict', message: 'policy changed on disk — reload the page and retry' })
  }
  return refusal(HTTP_STATUS_INTERNAL_ERROR, { status: 'error', message: 'the policy file could not be written', errors: written.errors })
}

/**
 * The inventory only refines the display-only `effective` line (quarantine
 * state); a corrupt or locked store degrades to the empty inventory rather
 * than failing a request whose edit already landed on disk.
 */
async function readInventoryOrDefault(deps: ServersToolRuleDeps): Promise<InventoryStoreData> {
  try {
    return (await deps.readInventory?.()) ?? DEFAULT_INVENTORY_STORE
  } catch {
    return DEFAULT_INVENTORY_STORE
  }
}

/** What the no-JS notice says the edit did, in the words of the form the admin submitted. */
function editMessage(parsed: ParsedRequest): string {
  const target = `${parsed.serverName}/${parsed.toolName}`
  return parsed.rule === null ? `cleared the rule for ${target}` : `set ${parsed.ruleField} for ${target}`
}

export function createServersToolRuleHandlers(deps: ServersToolRuleDeps): ServersToolRuleHandlers {
  /**
   * After the file is on disk: the attribution line, then the journal record —
   * each exactly once — and whether the record landed. The port never throws
   * by contract (`policy/edit/journal-edit.ts` answers with a drop indicator);
   * the guard keeps that true for ANY injected port, because a throw here
   * would turn a rule that is already live into a 500 with no record at all.
   */
  async function recordEdit(
    session: UiSession,
    parsed: ParsedRequest,
    sourcePath: string,
    written: Extract<PolicyFileWriteResult, { status: 'written' }>,
  ): Promise<PolicyEditJournalOutcome> {
    deps.audit?.({
      actor: 'ui',
      adminName: session.adminName,
      action: AUDIT_ACTION,
      target: `${parsed.serverName}/${parsed.toolName} ${parsed.ruleField}`,
    })
    try {
      const outcome = await deps.journal({
        actor: { adminName: session.adminName, role: session.role, via: 'ui' },
        serverName: parsed.serverName,
        toolName: parsed.toolName,
        rule: parsed.rule,
        policyHashBefore: written.hashBefore,
        policyHashAfter: written.hashAfter,
        sourcePath,
      })
      return { written: outcome.written }
    } catch {
      return { written: false }
    }
  }

  /**
   * The no-JS answer: the 303 back to `/servers` when the audit record landed,
   * a success notice carrying the F1 warning when it was dropped — a redirect
   * has nowhere to say it and `/servers` has no query-notice flag. Still a
   * 200: the file is on disk and the rule is live.
   */
  function formAnswer(session: UiSession, parsed: ParsedRequest, journal: PolicyEditJournalOutcome): UiResult {
    if (journal.written) {
      return { kind: 'response', status: HTTP_STATUS_SEE_OTHER, headers: { location: '/servers' } }
    }
    const body = renderNotice({
      title: 'Servers',
      message: editMessage(parsed),
      ok: true,
      backHref: '/servers',
      backLabel: 'Back to servers',
      session,
      warning: AUDIT_RECORD_DROPPED_WARNING,
    })
    return { kind: 'response', status: HTTP_STATUS_OK, headers: { 'content-type': CONTENT_TYPE_HTML }, body }
  }

  async function serversToolRule(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined || !roleSatisfies(session.role, 'owner')) {
      return jsonResult(HTTP_STATUS_FORBIDDEN, { status: 'forbidden', message: 'Owner role required.' })
    }
    const parsed = parseRequest(ctx)
    if (isRefusal(parsed)) return jsonResult(parsed.status, parsed.payload)

    const target = await loadTarget(deps)
    if (isRefusal(target)) return jsonResult(target.status, target.payload)

    const applied = applyToolRuleToDocument(target.read.document, parsed.serverName, parsed.toolName, parsed.rule)
    if (!applied.ok) return jsonResult(HTTP_STATUS_BAD_REQUEST, { status: 'invalid', message: applied.message })

    const written = await deps.writePolicyFile(target.path, applied.document, { expectedHash: parsed.expectedHash })
    if (written.status !== 'written') {
      const refused = writeRefusal(written)
      return jsonResult(refused.status, refused.payload)
    }

    // The file is on disk: attribute FIRST. Everything after this line is
    // display-only and must never turn a completed edit into an unjournaled one.
    const journal = await recordEdit(session, parsed, target.path, written)
    if (!wantsJson(ctx)) return formAnswer(session, parsed, journal)
    const inventory = await readInventoryOrDefault(deps)
    const effective = effectiveToolRule({
      policy: applied.policy,
      serverName: parsed.serverName,
      tool: { name: parsed.toolName, quarantineState: quarantineStateOf(inventory, parsed.serverName, parsed.toolName) },
    })
    const journalState: JournalRecordState = journal.written ? 'written' : 'dropped'
    return jsonResult(HTTP_STATUS_OK, {
      status: 'ok',
      server: parsed.serverName,
      tool: parsed.toolName,
      rule: parsed.rule,
      effective: { outcome: effective.outcome, source: effective.source },
      hashBefore: written.hashBefore,
      hashAfter: written.hashAfter,
      journal: journalState,
    })
  }

  return { serversToolRule }
}
