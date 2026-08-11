import type { ToolClass } from '../journal/record.js'

/**
 * The grant vocabulary for non-tool methods (M4 Task 6). M3 denied every
 * `resources/*`, `prompts/*` and `completion/complete` frame on an agent
 * session because the grant matrix could not DESCRIBE them; this module makes
 * that denial expressible instead of unconditional. The ban is not lifted —
 * `decideMethodGrant` returns `fallback` (= the byte-identical M3 denial)
 * whenever the corresponding grant is absent, and only an explicit
 * `resources`/`prompts` grant opens the enumerated methods below.
 *
 * Placement: this is agents-domain knowledge (what a grant can say, and what
 * a granted agent's view of a listing is), consumed by the gate router the
 * same way `agents/scope.ts` is — through a structural interface. Methods NOT
 * enumerated here (e.g. `resources/templates/list`) stay fail-closed on the
 * M3 family denial even under wildcard grants: a method added by a later spec
 * revision must be denied by default, never silently admitted.
 *
 * Policy rules for these methods are deliberately NOT introduced (M4
 * boundary): grants decide, the journal records — allow/deny rules for
 * non-tool methods are M5 backlog.
 */

// -- schema-facing constants (used by `schema.ts` and `store.ts`) ------------

/** Max resource URI patterns in a single grant (mirrors MAX_TOOLS_PER_GRANT). */
export const MAX_RESOURCES_PER_GRANT = 500

/** Max prompt name patterns in a single grant. */
export const MAX_PROMPTS_PER_GRANT = 500

/** Max characters of one resource URI pattern (bounds store size and matching cost). */
export const MAX_RESOURCE_PATTERN_CHARS = 2048

/**
 * Shape of a resource grant pattern: an exact URI, or a URI prefix with a
 * single trailing `*` — the same "exact or one trailing glob" SURFACE syntax
 * as tool patterns, widened to URI characters. Whitespace, control characters
 * and embedded `*` are rejected; a lone `*` is rejected too (the `'*'`
 * literal on the grant field is the way to say "everything"). MATCHING is not
 * lexical, though: both sides are normalized and prefixes bind on path-segment
 * boundaries (`agents/resource-match.ts` — security fix, M4 wave-1 review).
 */
export const RESOURCE_GRANT_PATTERN = /^[^\s\u0000-\u001f\u007f*]+\*?$/u

// -- the method-grant dimension of an agent's scope --------------------------

/**
 * What one agent's grant for one server says about non-tool methods.
 * Implemented by `agents/scope.ts`; the gate consumes it structurally
 * (`GateAgentScope.methodGrants`), so tests can supply their own. Its ABSENCE
 * on a gate scope is exactly the M3 behavior, byte for byte.
 */
export interface AgentMethodGrants {
  /** True iff the resources grant covers `uri` (exact or trailing-`*` prefix). */
  isResourceGranted(uri: string): boolean
  /** True iff the prompts grant covers `name` (same matcher as tools). */
  isPromptGranted(name: string): boolean
  /** True iff at least one resource pattern (or `'*'`) is granted. */
  hasResourcesGrant(): boolean
  /** True iff at least one prompt pattern (or `'*'`) is granted. */
  hasPromptsGrant(): boolean
}

/** The two grant-filtered listings and their wire shapes. */
export type MethodListKind = 'resources' | 'prompts'

/** `rule` prefix of the decision journaled for a method a grant admitted. */
export const AGENT_METHOD_GRANTED_RULE_PREFIX = 'agent: method granted'

/** `rule` prefix of the bookkeeping record for a grant-filtered listing. */
export const AGENT_METHOD_LIST_FILTERED_RULE_PREFIX = 'agent: grant-filtered'

/** `rule` prefix of the denial for a grant-managed method with unreadable params. */
export const AGENT_METHOD_MALFORMED_RULE_PREFIX = 'agent: malformed method params'

/**
 * Outcome of deciding one grant-managed frame. `fallback` instructs the
 * router to produce the EXACT M3 non-grantable denial (same rule, same
 * decision record) — the mechanism behind "default = M3 byte for byte".
 */
export type MethodGrantOutcome =
  | { readonly action: 'fallback' }
  | {
      readonly action: 'deny'
      readonly rule: string
      readonly toolClass: ToolClass
      readonly params: unknown
    }
  | {
      readonly action: 'forward'
      readonly rule: string
      readonly toolClass: ToolClass
      readonly params: unknown
      /** Present on list methods: the response must be grant-filtered. */
      readonly list?: MethodListKind
    }

/** How each enumerated method is checked, and its journal classification. */
type MethodSpec =
  | { readonly toolClass: ToolClass; readonly check: 'resource-uri' }
  | { readonly toolClass: ToolClass; readonly check: 'prompt-name' }
  | { readonly toolClass: ToolClass; readonly check: 'list'; readonly list: MethodListKind }
  | { readonly toolClass: ToolClass; readonly check: 'completion' }

/**
 * The enumerated grant-managed methods. Journal classification per plan:
 * read/list/get/complete → `read`; subscribe/unsubscribe → `write`.
 */
const GRANT_MANAGED_METHODS: Readonly<Record<string, MethodSpec>> = {
  'resources/read': { toolClass: 'read', check: 'resource-uri' },
  'resources/list': { toolClass: 'read', check: 'list', list: 'resources' },
  'resources/subscribe': { toolClass: 'write', check: 'resource-uri' },
  'resources/unsubscribe': { toolClass: 'write', check: 'resource-uri' },
  'prompts/get': { toolClass: 'read', check: 'prompt-name' },
  'prompts/list': { toolClass: 'read', check: 'list', list: 'prompts' },
  'completion/complete': { toolClass: 'read', check: 'completion' },
}

const FALLBACK: MethodGrantOutcome = Object.freeze({ action: 'fallback' as const })

/**
 * Decides one grant-managed frame from its method and raw JSON line. Pure:
 * no I/O, never throws (unreadable params on a checked method deny with the
 * malformed rule; anything not enumerated falls back to the M3 denial).
 */
export function decideMethodGrant(
  method: string,
  raw: string,
  grants: AgentMethodGrants | undefined,
): MethodGrantOutcome {
  if (grants === undefined) return FALLBACK
  const spec = Object.hasOwn(GRANT_MANAGED_METHODS, method)
    ? GRANT_MANAGED_METHODS[method]
    : undefined
  if (spec === undefined) return FALLBACK

  switch (spec.check) {
    case 'resource-uri':
      return decideSubject(method, raw, spec.toolClass, grants.hasResourcesGrant(), 'uri', {
        vocabulary: 'resources',
        isGranted: (uri) => grants.isResourceGranted(uri),
      })
    case 'prompt-name':
      return decideSubject(method, raw, spec.toolClass, grants.hasPromptsGrant(), 'name', {
        vocabulary: 'prompts',
        isGranted: (name) => grants.isPromptGranted(name),
      })
    case 'list':
      if (!hasListGrant(grants, spec.list)) return FALLBACK
      return {
        action: 'forward',
        rule: grantedRuleOf(method),
        toolClass: spec.toolClass,
        params: paramsOf(raw),
        list: spec.list,
      }
    case 'completion':
      return decideCompletion(method, raw, spec.toolClass, grants)
  }
}

/** The subject of a `completion/complete`: which vocabulary its `ref` names. */
type CompletionSubject =
  | { readonly kind: 'prompts'; readonly value: string }
  | { readonly kind: 'resources'; readonly value: string }

function completionSubjectOf(ref: unknown): CompletionSubject | null {
  if (!isPlainObject(ref)) return null
  if (ref['type'] === 'ref/prompt' && typeof ref['name'] === 'string') {
    return { kind: 'prompts', value: ref['name'] }
  }
  if (ref['type'] === 'ref/resource' && typeof ref['uri'] === 'string') {
    return { kind: 'resources', value: ref['uri'] }
  }
  return null
}

/**
 * `completion/complete` is gated by the SUBJECT of its `ref`, not by mere
 * grant presence (review M1): a `ref/prompt` must be covered by the prompts
 * grant, a `ref/resource` by the resources grant. A readable ref whose
 * vocabulary is not granted at all falls back to the M3 denial (like every
 * other method of an ungranted family); an unreadable ref is denied as
 * malformed, worst-case class (mirrors `decideSubject`).
 */
function decideCompletion(
  method: string,
  raw: string,
  toolClass: ToolClass,
  grants: AgentMethodGrants,
): MethodGrantOutcome {
  if (!grants.hasResourcesGrant() && !grants.hasPromptsGrant()) return FALLBACK
  const params = paramsOf(raw)
  const subject = completionSubjectOf(isPlainObject(params) ? params['ref'] : undefined)
  if (subject === null) return malformedDeny(method, params)

  const hasGrant = subject.kind === 'prompts' ? grants.hasPromptsGrant() : grants.hasResourcesGrant()
  if (!hasGrant) return FALLBACK

  const granted =
    subject.kind === 'prompts'
      ? grants.isPromptGranted(subject.value)
      : grants.isResourceGranted(subject.value)
  if (granted) return { action: 'forward', rule: grantedRuleOf(method), toolClass, params }
  return {
    action: 'deny',
    rule: `agent: no ${subject.kind} grant for ${subject.value}`,
    toolClass,
    params,
  }
}

/** Subject-bearing methods: extract `params[field]`, match it against the grant. */
function decideSubject(
  method: string,
  raw: string,
  toolClass: ToolClass,
  hasGrant: boolean,
  field: 'uri' | 'name',
  matcher: { readonly vocabulary: MethodListKind; readonly isGranted: (subject: string) => boolean },
): MethodGrantOutcome {
  if (!hasGrant) return FALLBACK
  const params = paramsOf(raw)
  const fieldValue = isPlainObject(params) ? params[field] : undefined
  const subject = typeof fieldValue === 'string' ? fieldValue : null
  if (subject === null) return malformedDeny(method, params)
  if (matcher.isGranted(subject)) {
    return { action: 'forward', rule: grantedRuleOf(method), toolClass, params }
  }
  return {
    action: 'deny',
    rule: `agent: no ${matcher.vocabulary} grant for ${subject}`,
    toolClass,
    params,
  }
}

function grantedRuleOf(method: string): string {
  return `${AGENT_METHOD_GRANTED_RULE_PREFIX}: ${method}`
}

/**
 * Fail closed with the worst-case class: the frame claimed a checked method
 * but carried no checkable subject (mirrors unsafe-frame handling).
 */
function malformedDeny(method: string, params: unknown): MethodGrantOutcome {
  return {
    action: 'deny',
    rule: `${AGENT_METHOD_MALFORMED_RULE_PREFIX}: ${method}`,
    toolClass: 'destructive',
    params,
  }
}

function hasListGrant(grants: AgentMethodGrants, list: MethodListKind): boolean {
  return list === 'resources' ? grants.hasResourcesGrant() : grants.hasPromptsGrant()
}

/** The per-item grant check for one listing kind. */
export function listItemPredicate(
  grants: AgentMethodGrants,
  list: MethodListKind,
): (subject: string) => boolean {
  return list === 'resources'
    ? (uri) => grants.isResourceGranted(uri)
    : (name) => grants.isPromptGranted(name)
}

/** Result of grant-filtering one listing response. */
export interface FilteredMethodList {
  /** The rewritten JSON line (no framing), unknown fields preserved. */
  readonly serialized: string
  /** Subjects of readable entries the grant did not cover, in wire order. */
  readonly removed: readonly string[]
  readonly kept: number
  /** Entries with no readable subject: dropped, because an allowlist that admits what it cannot check is not an allowlist. */
  readonly droppedUnreadable: number
}

/**
 * Rewrites a `resources/list`/`prompts/list` result down to the granted
 * items, leaving every other field of the message and of `result`
 * (`nextCursor`, `_meta`, vendor fields on kept items) untouched — the same
 * direct-rewrite approach as `proxy/tools-filter.ts`, for the same reason.
 * Returns `null` for any shape it does not positively recognize (the caller
 * forwards the original), including a rewrite that would break line framing.
 */
export function filterMethodListResult(
  raw: string,
  list: MethodListKind,
  isGranted: (subject: string) => boolean,
): FilteredMethodList | null {
  const parsed = tryParseObject(raw)
  if (parsed === null) return null
  const result = parsed['result']
  if (!isPlainObject(result)) return null
  const items = result[list]
  if (!Array.isArray(items)) return null

  const field = list === 'resources' ? 'uri' : 'name'
  const removed: string[] = []
  let droppedUnreadable = 0
  const keptItems = items.filter((item) => {
    if (!isPlainObject(item) || typeof item[field] !== 'string') {
      droppedUnreadable += 1
      return false
    }
    const subject = item[field] as string
    if (isGranted(subject)) return true
    removed.push(subject)
    return false
  })

  const serialized = JSON.stringify({ ...parsed, result: { ...result, [list]: keptItems } })
  if (serialized.includes('\n')) return null

  return { serialized, removed, kept: keptItems.length, droppedUnreadable }
}

function paramsOf(raw: string): unknown {
  const parsed = tryParseObject(raw)
  return parsed === null ? undefined : parsed['params']
}

function tryParseObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw)
    return isPlainObject(value) ? value : null
  } catch {
    return null
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
