import { MAX_SERVERS_IN_POLICY, MAX_TOOL_RULES_PER_SERVER, RESERVED_OBJECT_KEYS, TOOL_RULE_NAME_PATTERN } from '../constants.js'
import { formatPolicyErrors } from '../load.js'
import { parsePolicy, SERVER_NAME_PATTERN, type Policy, type PolicyOutcome } from '../schema.js'

/**
 * The one pure edit the UI and `policy set` perform on `policy.json` (plan
 * policy-tool-rules-ui §1): write or remove an EXACT per-tool rule under
 * `servers.<server>.tools.<tool>` — applied to the RAW parsed document, not
 * to the defaulted `Policy`.
 *
 * Structural on purpose: the file stays the operator's. A minimal
 * `{"version":1}` stays minimal after an edit (no spelled-out `approval`/
 * `quarantine` defaults pinning today's `DEFAULT_*` values), every key the
 * operator wrote is carried over as parsed, and only the one rule moves.
 *
 * Exact on purpose: `match.ts` lets an exact key beat any `prefix*` rule, so
 * a per-tool button always overrides whatever wildcard also matches, and a
 * reset (`null`) removes only that exact key — a wildcard the operator wrote
 * by hand is never touched from here.
 *
 * Never mutates its input, never throws for a bad edit (a typed result, like
 * `parsePolicy`), and never returns a document the loader would refuse: the
 * candidate goes through `parsePolicy`, so what cannot be loaded cannot be
 * written — and the parsed result is returned as the effective `policy` for
 * `policyHashOf` and for reporting the outcome after the edit.
 */

/** Why an edit was refused. Names, not prose, so a caller can map each to its own message or HTTP status. */
export type ToolRuleEditFailureReason =
  | 'invalid-server-name'
  | 'invalid-tool-name'
  | 'too-many-servers'
  | 'too-many-tool-rules'
  | 'invalid-policy'

export type ApplyToolRuleResult =
  | { readonly ok: true; readonly document: unknown; readonly policy: Policy }
  | { readonly ok: false; readonly reason: ToolRuleEditFailureReason; readonly message: string }

type Failure = Extract<ApplyToolRuleResult, { readonly ok: false }>
type PlainObject = Record<string, unknown>

/** The three nested maps an edit touches, each `undefined` when the document does not have it yet. */
interface DocumentShape {
  readonly document: PlainObject
  readonly servers: PlainObject | undefined
  readonly entry: PlainObject | undefined
  readonly tools: PlainObject | undefined
}

const SERVERS_KEY = 'servers'
const TOOLS_KEY = 'tools'
/** The wildcard suffix a tool-rule key may carry; a per-tool rule never does. */
const WILDCARD_SUFFIX = '*'

/**
 * Sets `rule` as the exact rule for `toolName` on `serverName` in the raw
 * `document`, or removes the exact rule when `rule` is `null`. Creates
 * `servers` / the server entry / `tools` as needed; removal prunes what it
 * empties (an empty `tools`, a server entry with nothing left, an empty
 * `servers`) so repeated set/reset cycles leave no husks in the file, while a
 * server that still has a `defaultDecision` or `classOverrides` is kept.
 */
export function applyToolRuleToDocument(
  document: unknown,
  serverName: string,
  toolName: string,
  rule: PolicyOutcome | null,
): ApplyToolRuleResult {
  const nameFailure = validateNames(serverName, toolName)
  if (nameFailure !== undefined) return nameFailure

  const shape = shapeOf(document, serverName)
  if (!shape.ok) return shape
  if (rule !== null) {
    const limitFailure = checkLimits(shape.shape, serverName, toolName)
    if (limitFailure !== undefined) return limitFailure
  }

  const next = rule === null ? withoutRule(shape.shape, serverName, toolName) : withRule(shape.shape, serverName, toolName, rule)
  const parsed = parsePolicy(next)
  if (!parsed.ok) return failure('invalid-policy', formatPolicyErrors(parsed.error).join('; '))
  return { ok: true, document: next, policy: parsed.policy }
}

function validateNames(serverName: string, toolName: string): Failure | undefined {
  if (!SERVER_NAME_PATTERN.test(serverName) || RESERVED_OBJECT_KEYS.includes(serverName)) {
    return failure('invalid-server-name', `invalid server name "${serverName}"`)
  }
  const isExactToolName = TOOL_RULE_NAME_PATTERN.test(toolName) && !toolName.endsWith(WILDCARD_SUFFIX)
  if (!isExactToolName || RESERVED_OBJECT_KEYS.includes(toolName)) {
    return failure('invalid-tool-name', `invalid tool name "${toolName}": a per-tool rule must be an exact name`)
  }
  return undefined
}

type ShapeResult = { readonly ok: true; readonly shape: DocumentShape } | Failure

/**
 * Locates the maps the edit touches. Anything on that path that is present
 * but not an object cannot be edited structurally and is refused as
 * `invalid-policy` (`readPolicyFileForEdit` refuses such files up front, so
 * a caller normally never sees this).
 */
function shapeOf(document: unknown, serverName: string): ShapeResult {
  if (!isPlainObject(document)) return failure('invalid-policy', 'policy document is not an object')
  const servers = ownValue(document, SERVERS_KEY)
  if (!isOptionalObject(servers)) return failure('invalid-policy', `"${SERVERS_KEY}" is not an object`)
  const entry = servers === undefined ? undefined : ownValue(servers, serverName)
  if (!isOptionalObject(entry)) return failure('invalid-policy', `"${SERVERS_KEY}.${serverName}" is not an object`)
  const tools = entry === undefined ? undefined : ownValue(entry, TOOLS_KEY)
  if (!isOptionalObject(tools)) {
    return failure('invalid-policy', `"${SERVERS_KEY}.${serverName}.${TOOLS_KEY}" is not an object`)
  }
  return { ok: true, shape: { document, servers, entry, tools } }
}

/**
 * The schema's map caps, checked up front so the caller gets a named reason
 * instead of a generic `invalid-policy`. Only ADDING a key can breach a cap:
 * replacing an existing rule on a full map is fine.
 */
function checkLimits(shape: DocumentShape, serverName: string, toolName: string): Failure | undefined {
  if (shape.entry === undefined && keyCount(shape.servers) >= MAX_SERVERS_IN_POLICY) {
    return failure('too-many-servers', `policy already has ${MAX_SERVERS_IN_POLICY} servers; cannot add "${serverName}"`)
  }
  const isNewRule = shape.tools === undefined || !Object.hasOwn(shape.tools, toolName)
  if (isNewRule && keyCount(shape.tools) >= MAX_TOOL_RULES_PER_SERVER) {
    return failure(
      'too-many-tool-rules',
      `server "${serverName}" already has ${MAX_TOOL_RULES_PER_SERVER} tool rules; cannot add "${toolName}"`,
    )
  }
  return undefined
}

function withRule(shape: DocumentShape, serverName: string, toolName: string, rule: PolicyOutcome): PlainObject {
  const tools = { ...(shape.tools ?? {}), [toolName]: rule }
  const entry = { ...(shape.entry ?? {}), [TOOLS_KEY]: tools }
  return { ...shape.document, [SERVERS_KEY]: { ...(shape.servers ?? {}), [serverName]: entry } }
}

function withoutRule(shape: DocumentShape, serverName: string, toolName: string): PlainObject {
  const { document, servers, entry, tools } = shape
  if (servers === undefined || entry === undefined || tools === undefined || !Object.hasOwn(tools, toolName)) {
    return document
  }
  const remainingTools = omitKey(tools, toolName)
  const bareEntry = omitKey(entry, TOOLS_KEY)
  const nextEntry = keyCount(remainingTools) > 0 ? { ...bareEntry, [TOOLS_KEY]: remainingTools } : bareEntry
  const nextServers = keyCount(nextEntry) > 0 ? { ...servers, [serverName]: nextEntry } : omitKey(servers, serverName)
  return keyCount(nextServers) > 0 ? { ...document, [SERVERS_KEY]: nextServers } : omitKey(document, SERVERS_KEY)
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOptionalObject(value: unknown): value is PlainObject | undefined {
  return value === undefined || isPlainObject(value)
}

/** Own-property lookup: a `constructor` server name must never reach the prototype. */
function ownValue(record: PlainObject, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function keyCount(record: PlainObject | undefined): number {
  return record === undefined ? 0 : Object.keys(record).length
}

/** A copy of `record` without `key`, key order preserved; the input is never touched. */
function omitKey(record: PlainObject, key: string): PlainObject {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))
}

function failure(reason: ToolRuleEditFailureReason, message: string): Failure {
  return { ok: false, reason, message }
}
