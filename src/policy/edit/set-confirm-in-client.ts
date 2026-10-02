import {
  CONFIRM_AGENT_NAME_PATTERN,
  CONFIRM_ANY_AGENT,
  MAX_CONFIRM_AGENTS,
  MAX_SERVERS_IN_POLICY,
  MAX_TOOL_RULES_PER_SERVER,
  RESERVED_OBJECT_KEYS,
} from '../constants.js'
import { formatPolicyErrors } from '../load.js'
import { isExactToolRuleName } from '../tool-name.js'
import { parsePolicy, SERVER_NAME_PATTERN, type Policy } from '../schema.js'
import { isOptionalObject, isPlainObject, keyCount, omitKey, ownValue, type PlainObject } from './plain-object.js'

/**
 * The pure edit behind the per-tool "client" control (ADR-0019): write or
 * remove the EXACT key for one tool under `servers.<server>.confirmInClient`
 * in the RAW parsed document — the sibling of `applyToolRuleToDocument`, with
 * the same promises. Structural (every other key stays as the operator wrote
 * it), exact (an exact key beats any `prefix*`, and a reset removes only that
 * key), immutable, never throwing for a bad edit, and never returning a
 * document the loader would refuse: the candidate goes through `parsePolicy`.
 */

export type ConfirmEditFailureReason =
  | 'invalid-server-name'
  | 'invalid-tool-name'
  | 'invalid-agent-name'
  | 'no-agents'
  | 'too-many-agents'
  | 'too-many-servers'
  | 'too-many-rules'
  | 'invalid-policy'

export type ApplyConfirmResult =
  | { readonly ok: true; readonly document: unknown; readonly policy: Policy }
  | { readonly ok: false; readonly reason: ConfirmEditFailureReason; readonly message: string }

type Failure = Extract<ApplyConfirmResult, { readonly ok: false }>

/** The three nested maps an edit touches, each `undefined` when the document does not have it yet. */
interface DocumentShape {
  readonly document: PlainObject
  readonly servers: PlainObject | undefined
  readonly entry: PlainObject | undefined
  readonly confirm: PlainObject | undefined
}

const SERVERS_KEY = 'servers'
const CONFIRM_KEY = 'confirmInClient'

/**
 * Sets the agents that confirm `toolName` on `serverName`, or removes the
 * exact key when `agents` is `null`. Names are deduplicated in first-seen
 * order; `"*"` among them stores just `["*"]`. Removal prunes what it empties
 * (the map, a server entry with nothing left, an empty `servers`).
 */
export function applyConfirmInClientToDocument(
  document: unknown,
  serverName: string,
  toolName: string,
  agents: readonly string[] | null,
): ApplyConfirmResult {
  const invalid = validateNames(serverName, toolName) ?? (agents === null ? undefined : validateAgents(agents))
  if (invalid !== undefined) return invalid

  const shape = shapeOf(document, serverName)
  if (!shape.ok) return shape
  if (agents !== null) {
    const limitFailure = checkLimits(shape.shape, serverName, toolName)
    if (limitFailure !== undefined) return limitFailure
  }

  const next =
    agents === null
      ? withoutKey(shape.shape, serverName, toolName)
      : withKey(shape.shape, serverName, toolName, normalizedAgents(agents))
  const parsed = parsePolicy(next)
  if (!parsed.ok) return failure('invalid-policy', formatPolicyErrors(parsed.error).join('; '))
  return { ok: true, document: next, policy: parsed.policy }
}

function validateNames(serverName: string, toolName: string): Failure | undefined {
  if (!SERVER_NAME_PATTERN.test(serverName) || RESERVED_OBJECT_KEYS.includes(serverName)) {
    return failure('invalid-server-name', `invalid server name "${serverName}"`)
  }
  if (!isExactToolRuleName(toolName)) {
    return failure('invalid-tool-name', `invalid tool name "${toolName}": a per-tool rule must be an exact name`)
  }
  return undefined
}

function validateAgents(agents: readonly string[]): Failure | undefined {
  if (agents.length === 0) return failure('no-agents', 'name at least one agent, or "*" for all')
  const bad = agents.find((name) => name !== CONFIRM_ANY_AGENT && !CONFIRM_AGENT_NAME_PATTERN.test(name))
  if (bad !== undefined) return failure('invalid-agent-name', `invalid agent name "${bad}"`)
  if (normalizedAgents(agents).length > MAX_CONFIRM_AGENTS) {
    return failure('too-many-agents', `at most ${MAX_CONFIRM_AGENTS} agents per tool; use "*" for all`)
  }
  return undefined
}

function normalizedAgents(agents: readonly string[]): readonly string[] {
  return agents.includes(CONFIRM_ANY_AGENT) ? [CONFIRM_ANY_AGENT] : [...new Set(agents)]
}

type ShapeResult = { readonly ok: true; readonly shape: DocumentShape } | Failure

/** Locates the maps the edit touches; anything on that path that is present but not an object is `invalid-policy`. */
function shapeOf(document: unknown, serverName: string): ShapeResult {
  if (!isPlainObject(document)) return failure('invalid-policy', 'policy document is not an object')
  const servers = ownValue(document, SERVERS_KEY)
  if (!isOptionalObject(servers)) return failure('invalid-policy', `"${SERVERS_KEY}" is not an object`)
  const entry = servers === undefined ? undefined : ownValue(servers, serverName)
  if (!isOptionalObject(entry)) return failure('invalid-policy', `"${SERVERS_KEY}.${serverName}" is not an object`)
  const confirm = entry === undefined ? undefined : ownValue(entry, CONFIRM_KEY)
  if (!isOptionalObject(confirm)) {
    return failure('invalid-policy', `"${SERVERS_KEY}.${serverName}.${CONFIRM_KEY}" is not an object`)
  }
  return { ok: true, shape: { document, servers, entry, confirm } }
}

/** The schema's map caps, checked up front for a named reason; only ADDING a key can breach one. */
function checkLimits(shape: DocumentShape, serverName: string, toolName: string): Failure | undefined {
  if (shape.entry === undefined && keyCount(shape.servers) >= MAX_SERVERS_IN_POLICY) {
    return failure('too-many-servers', `policy already has ${MAX_SERVERS_IN_POLICY} servers; cannot add "${serverName}"`)
  }
  const isNewKey = shape.confirm === undefined || !Object.hasOwn(shape.confirm, toolName)
  if (isNewKey && keyCount(shape.confirm) >= MAX_TOOL_RULES_PER_SERVER) {
    return failure(
      'too-many-rules',
      `server "${serverName}" already has ${MAX_TOOL_RULES_PER_SERVER} client-confirmation rules; cannot add "${toolName}"`,
    )
  }
  return undefined
}

function withKey(shape: DocumentShape, serverName: string, toolName: string, agents: readonly string[]): PlainObject {
  const confirm = { ...(shape.confirm ?? {}), [toolName]: agents }
  const entry = { ...(shape.entry ?? {}), [CONFIRM_KEY]: confirm }
  return { ...shape.document, [SERVERS_KEY]: { ...(shape.servers ?? {}), [serverName]: entry } }
}

function withoutKey(shape: DocumentShape, serverName: string, toolName: string): PlainObject {
  const { document, servers, entry, confirm } = shape
  if (servers === undefined || entry === undefined || confirm === undefined || !Object.hasOwn(confirm, toolName)) {
    return document
  }
  const remaining = omitKey(confirm, toolName)
  const bareEntry = omitKey(entry, CONFIRM_KEY)
  const nextEntry = keyCount(remaining) > 0 ? { ...bareEntry, [CONFIRM_KEY]: remaining } : bareEntry
  const nextServers = keyCount(nextEntry) > 0 ? { ...servers, [serverName]: nextEntry } : omitKey(servers, serverName)
  return keyCount(nextServers) > 0 ? { ...document, [SERVERS_KEY]: nextServers } : omitKey(document, SERVERS_KEY)
}

function failure(reason: ConfirmEditFailureReason, message: string): Failure {
  return { ok: false, reason, message }
}
