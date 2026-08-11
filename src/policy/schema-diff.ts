import { SCHEMA_DIFF_MAX_CHANGES, SCHEMA_DIFF_MAX_DEPTH } from './constants.js'

/**
 * Pure structural diff of two tool `inputSchema` values (M4, backlog line 45).
 *
 * The quarantine flow already DETECTS a change via `hashToolSchema` -- that
 * detection is untouched. This module answers the operator's next question:
 * "changed HOW?" -- e.g. "optional property `force` was added" -- so the
 * quarantine card (UI) and `quarantine show` (CLI) can render a readable diff
 * instead of "hashes diverged".
 *
 * Both inputs come from an untrusted server's `tools/list`, so the diff is
 * total: it never throws, never mutates its inputs, performs no I/O, and caps
 * its own recursion depth and output size (`truncated: true` past a cap).
 *
 * `surfaceDelta` summarizes the direction of the change for display and for
 * the decision record. In M4 it is computed and persisted but NEVER changes a
 * tool's classification -- escalation on a widened surface is an M5 rule
 * (needs decision provenance; see plan, backlog line 46).
 */

/** Direction of a schema's accepted-input surface after the change. */
export type SurfaceDelta = 'widened' | 'narrowed' | 'changed' | 'neutral'

export type SchemaChangeKind =
  | 'property-added'
  | 'property-removed'
  | 'required-added'
  | 'required-removed'
  | 'enum-widened'
  | 'enum-narrowed'
  | 'enum-changed'
  | 'type-changed'
  | 'keyword-added'
  | 'keyword-removed'
  | 'keyword-changed'
  | 'description-changed'
  | 'annotation-changed'
  | 'schema-changed'

export interface SchemaChange {
  readonly kind: SchemaChangeKind
  readonly path: string
}

export interface SchemaDiffResult {
  readonly changes: readonly SchemaChange[]
  readonly surfaceDelta: SurfaceDelta
  /** `true` when the diff hit a depth/size cap and the change list is incomplete. */
  readonly truncated: boolean
}

/**
 * Keys whose edit does not alter what inputs a schema accepts. A
 * description-only edit still quarantines the tool (the hash covers it);
 * the diff just reports it as `neutral` so the operator sees "wording only".
 */
const NEUTRAL_KEYS: ReadonlySet<string> = new Set(['description', 'title', 'examples', '$comment'])

const DELTA_BY_KIND: Readonly<Record<SchemaChangeKind, SurfaceDelta>> = {
  'property-added': 'widened',
  'property-removed': 'narrowed',
  'required-added': 'narrowed',
  'required-removed': 'widened',
  'enum-widened': 'widened',
  'enum-narrowed': 'narrowed',
  'enum-changed': 'changed',
  'type-changed': 'changed',
  'keyword-added': 'changed',
  'keyword-removed': 'changed',
  'keyword-changed': 'changed',
  'description-changed': 'neutral',
  'annotation-changed': 'neutral',
  'schema-changed': 'changed',
}

/** Internal accumulator; local to one `diffToolSchemas` call, never an input. */
interface DiffState {
  readonly changes: SchemaChange[]
  truncated: boolean
}

/**
 * Diffs `before` against `after` (each a tool's `inputSchema`, of unknown,
 * untrusted shape). Pure: no I/O, no input mutation, never throws.
 */
export function diffToolSchemas(before: unknown, after: unknown): SchemaDiffResult {
  const state: DiffState = { changes: [], truncated: false }
  diffNode(before, after, '', 0, state)
  return {
    changes: state.changes,
    surfaceDelta: aggregateDelta(state.changes),
    truncated: state.truncated,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function joinPath(path: string, segment: string): string {
  return path === '' ? segment : `${path}.${segment}`
}

function push(state: DiffState, kind: SchemaChangeKind, path: string): void {
  if (state.changes.length >= SCHEMA_DIFF_MAX_CHANGES) {
    state.truncated = true
    return
  }
  state.changes.push({ kind, path })
}

function diffNode(before: unknown, after: unknown, path: string, depth: number, state: DiffState): void {
  if (depth > SCHEMA_DIFF_MAX_DEPTH) {
    state.truncated = true
    return
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    diffObject(before, after, path, depth, state)
    return
  }
  if (!deepEqualBounded(before, after, depth, state)) push(state, 'schema-changed', path)
}

function diffObject(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: string,
  depth: number,
  state: DiffState,
): void {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  for (const key of keys) {
    // Once truncated the result is incomplete either way; stop the walk so the
    // caps bound WORK, not just output (review M4).
    if (state.truncated) return
    diffKey(before[key], after[key], key, path, depth, state)
  }
}

/** Dispatches one object key to its schema-aware comparison. */
function diffKey(
  before: unknown,
  after: unknown,
  key: string,
  path: string,
  depth: number,
  state: DiffState,
): void {
  const keyPath = joinPath(path, key)
  if (key === 'properties') {
    diffProperties(asObject(before), asObject(after), path, depth, state)
    return
  }
  if (key === 'required') {
    diffRequired(before, after, keyPath, state)
    return
  }
  if (key === 'enum' && Array.isArray(before) && Array.isArray(after)) {
    diffEnum(before, after, keyPath, state)
    return
  }
  if (key === 'type') {
    if (!deepEqualBounded(before, after, depth, state)) push(state, 'type-changed', keyPath)
    return
  }
  if (NEUTRAL_KEYS.has(key)) {
    if (!deepEqualBounded(before, after, depth, state)) {
      push(state, key === 'description' ? 'description-changed' : 'annotation-changed', keyPath)
    }
    return
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    diffNode(before, after, keyPath, depth + 1, state)
    return
  }
  if (before === undefined) {
    push(state, 'keyword-added', keyPath)
    return
  }
  if (after === undefined) {
    push(state, 'keyword-removed', keyPath)
    return
  }
  if (!deepEqualBounded(before, after, depth, state)) push(state, 'keyword-changed', keyPath)
}

function asObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
}

function diffProperties(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  parentPath: string,
  depth: number,
  state: DiffState,
): void {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  for (const name of names) {
    if (state.truncated) return
    const propPath = joinPath(parentPath, `properties.${name}`)
    const inBefore = Object.hasOwn(before, name)
    const inAfter = Object.hasOwn(after, name)
    if (inBefore && inAfter) diffNode(before[name], after[name], propPath, depth + 1, state)
    else push(state, inAfter ? 'property-added' : 'property-removed', propPath)
  }
}

/** `required` is compared as a set of names; non-arrays/non-strings contribute nothing. */
function diffRequired(before: unknown, after: unknown, keyPath: string, state: DiffState): void {
  const beforeNames = stringSetOf(before)
  const afterNames = stringSetOf(after)
  for (const name of [...afterNames].sort()) {
    if (state.truncated) return
    if (!beforeNames.has(name)) push(state, 'required-added', `${keyPath}.${name}`)
  }
  for (const name of [...beforeNames].sort()) {
    if (state.truncated) return
    if (!afterNames.has(name)) push(state, 'required-removed', `${keyPath}.${name}`)
  }
}

function stringSetOf(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) return new Set()
  return new Set(value.filter((item): item is string => typeof item === 'string'))
}

/** `enum` is compared as a set of serialized members: superset = widened, subset = narrowed. */
function diffEnum(before: readonly unknown[], after: readonly unknown[], keyPath: string, state: DiffState): void {
  const beforeSet = new Set(before.map(enumMemberKey))
  const afterSet = new Set(after.map(enumMemberKey))
  const added = [...afterSet].some((member) => !beforeSet.has(member))
  const removed = [...beforeSet].some((member) => !afterSet.has(member))
  if (!added && !removed) return
  const kind: SchemaChangeKind = added && removed ? 'enum-changed' : added ? 'enum-widened' : 'enum-narrowed'
  push(state, kind, keyPath)
}

function enumMemberKey(member: unknown): string {
  try {
    return String(JSON.stringify(member))
  } catch {
    return '[unserializable]'
  }
}

/**
 * Depth-bounded structural equality. Past the cap it reports "equal" and sets
 * `truncated` -- the diff must under-report rather than fabricate changes it
 * could not actually compare (the hash still flags the tool as changed).
 */
function deepEqualBounded(a: unknown, b: unknown, depth: number, state: DiffState): boolean {
  if (depth > SCHEMA_DIFF_MAX_DEPTH) {
    state.truncated = true
    return true
  }
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((item, index) => deepEqualBounded(item, b[index], depth + 1, state))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a).sort()
    const bKeys = Object.keys(b).sort()
    if (aKeys.length !== bKeys.length) return false
    if (aKeys.some((key, index) => key !== bKeys[index])) return false
    return aKeys.every((key) => deepEqualBounded(a[key], b[key], depth + 1, state))
  }
  return false
}

function aggregateDelta(changes: readonly SchemaChange[]): SurfaceDelta {
  let acc: SurfaceDelta = 'neutral'
  for (const change of changes) acc = combineDelta(acc, DELTA_BY_KIND[change.kind])
  return acc
}

function combineDelta(a: SurfaceDelta, b: SurfaceDelta): SurfaceDelta {
  if (a === 'changed' || b === 'changed') return 'changed'
  if (a === 'neutral') return b
  if (b === 'neutral') return a
  return a === b ? a : 'changed'
}
