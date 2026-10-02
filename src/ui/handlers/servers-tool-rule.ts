import { RESERVED_OBJECT_KEYS, TOOL_RULE_NAME_PATTERN } from '../../policy/constants.js'
import type { PolicyFileWriteResult } from '../../policy/edit/policy-file.js'
import { applyToolRuleToDocument } from '../../policy/edit/set-tool-rule.js'
import { effectiveToolRule } from '../../policy/effective.js'
import { DEFAULT_INVENTORY_STORE, type InventoryStoreData } from '../../policy/inventory-store.js'
import type { PolicyOutcome } from '../../policy/schema.js'
import type { UiSession } from '../auth.js'
import { roleSatisfies } from '../authz.js'
import { HTTP_STATUS_BAD_REQUEST, HTTP_STATUS_FORBIDDEN, HTTP_STATUS_OK } from '../constants.js'
import { quarantineStateOf, TOOL_RULE_FIELD_VALUES, type ToolRuleField } from '../pages/servers-tool-rule.js'
import { headerValue, parseBodyFields, type UiHandler, type UiRequestContext, type UiResult } from '../routes.js'
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

export type { PolicyEditJournalOutcome } from './policy-edit-common.js'

export interface ServersToolRuleDeps extends PolicyEditPorts {
  /** Read port for the inventory; the effective outcome after an edit honors quarantine through it. */
  readonly readInventory?: () => Promise<InventoryStoreData>
}

export interface ServersToolRuleHandlers {
  readonly serversToolRule: UiHandler
}

/** Body field names of the rule form (`pages/servers-tool-rule.ts` renders them). */
const RULE_FIELD = 'rule'
const AUDIT_ACTION = 'policy.set'
const WILDCARD_SUFFIX = '*'

interface ParsedRequest {
  readonly serverName: string
  readonly toolName: string
  readonly rule: PolicyOutcome | null
  readonly ruleField: ToolRuleField
  readonly expectedHash: string
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
  function recordEdit(
    session: UiSession,
    parsed: ParsedRequest,
    sourcePath: string,
    written: Extract<PolicyFileWriteResult, { status: 'written' }>,
  ): Promise<PolicyEditJournalOutcome> {
    return recordPolicyEdit(
      deps,
      session,
      { action: AUDIT_ACTION, target: `${parsed.serverName}/${parsed.toolName} ${parsed.ruleField}` },
      {
        serverName: parsed.serverName,
        toolName: parsed.toolName,
        rule: parsed.rule,
        policyHashBefore: written.hashBefore,
        policyHashAfter: written.hashAfter,
        sourcePath,
      },
    )
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
    if (!wantsJson(ctx)) return formAnswer(session, editMessage(parsed), journal)
    const inventory = await readInventoryOrDefault(deps)
    const effective = effectiveToolRule({
      policy: applied.policy,
      serverName: parsed.serverName,
      tool: { name: parsed.toolName, quarantineState: quarantineStateOf(inventory, parsed.serverName, parsed.toolName) },
    })
    const journalState: 'written' | 'dropped' = journal.written ? 'written' : 'dropped'
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
