import type { QuarantineState } from '../journal/record.js'
import type { ToolDescriptor } from '../protocol/mcp.js'
import { redact, redactString } from '../redact/redact.js'
import {
  MAX_SCHEMA_SUMMARY_NAMES,
  MAX_SCHEMA_SUMMARY_NAME_CHARS,
  MAX_STORED_DESCRIPTION_CHARS,
  MAX_STORED_DESCRIPTOR_CHARS,
  MAX_STORED_SCHEMA_CHARS,
} from './constants.js'
import { hashToolSchema } from './hash.js'
import {
  type ApprovedToolRecord,
  type QuarantinedToolRecord,
  type ServerInventory,
  emptyMap,
  isPlainObject,
  toStoredToolDescriptor,
  withKey,
} from './inventory-store.js'
import { diffToolSchemas, type SurfaceDelta } from './schema-diff.js'

/** Appended when a stored description is truncated at `MAX_STORED_DESCRIPTION_CHARS`. */
const DESCRIPTION_TRUNCATION_MARKER = '…[TRUNCATED]'

/** Length of the `shortHash` field on `QuarantinedEntry` (for CLI display). */
const SHORT_HASH_CHARS = 12

/** Prefix on the synthetic hash of a descriptor that could not be hashed/redacted (see C3). */
const UNHASHABLE_PREFIX = 'unhashable:'

/** Result of one `observeToolsList` call: tool names bucketed by disposition, plus a fault flag. */
export interface ObserveResult {
  readonly known: readonly string[]
  readonly new: readonly string[]
  readonly changed: readonly string[]
  /** `true` iff persisting the observation failed (disk/corrupt store), never for a per-tool fault. */
  readonly failed: boolean
}

/** A quarantined tool, flattened for CLI listing/display. */
export interface QuarantinedEntry {
  readonly serverName: string
  readonly toolName: string
  readonly state: 'new' | 'changed'
  readonly firstSeenAt: string
  readonly shortHash: string
  /** Present on `changed` entries with an approved descriptor to diff against (M4). */
  readonly surfaceDelta?: SurfaceDelta
}

export interface Observation {
  readonly buckets: { readonly known: string[]; readonly new: string[]; readonly changed: string[] }
  readonly snapshot: ReadonlyMap<string, QuarantineState>
  readonly nextServerEntry: ServerInventory
  /** `true` when the per-server quarantine cap was hit; caller marks the catalog untrusted. */
  readonly capExceeded: boolean
}

/** Fingerprints one tool, isolating any hash/redact fault as an "unhashable" quarantine (never a throw). */
function fingerprint(tool: ToolDescriptor): { schemaHash: string; stored: StoredDescriptor } {
  try {
    return { schemaHash: hashToolSchema(tool), stored: redactedDescriptorFor(tool, 'keep-schema') }
  } catch {
    const safeName = safeToolName(tool.name)
    return {
      schemaHash: `${UNHASHABLE_PREFIX}${safeName}`,
      stored: {
        descriptor: { name: tool.name, description: '[UNHASHABLE DESCRIPTOR]' },
        schemaTruncated: false,
      },
    }
  }
}

function safeToolName(name: unknown): string {
  try {
    return redactString(String(name))
  } catch {
    return '<unprintable>'
  }
}

/**
 * Direction of the schema-surface change vs the APPROVED stored descriptor, or
 * `undefined` when no direction can be honestly claimed. Only computable for a
 * changed tool whose approved record still carries a descriptor (records
 * approved before M4 stored none).
 *
 * A TRUNCATED DIFF YIELDS NO DIRECTION (M5 wave-6 review, found independently
 * by both reviewers as the load-bearing hole in O4). `diffToolSchemas` stops
 * the ENTIRE walk once it hits its depth or change-count cap -- including
 * branches that are neither deep nor large, merely sorted after the one that
 * tripped it. A hostile server pairs a deeply nested decoy under a
 * low-sorting name with a genuinely new property under a higher-sorting one:
 * the decoy exhausts the budget, the new property is never compared, and the
 * visible changes aggregate to a confident `neutral` or `narrowed`. Since
 * wave 6 that verdict decides whether an operator's explicit `allow` still
 * covers the tool (`decide.ts`), so a direction derived from a partial walk is
 * worse than no direction at all: no direction escalates, a manufactured
 * `narrowed` silently does not. The M4 comment that lived here -- "under-
 * reporting is fine, it never changes a tool's classification" -- was true
 * exactly until this signal started changing outcomes.
 */
function surfaceDeltaAgainstApproved(
  approvedRecord: ApprovedToolRecord | undefined,
  observedDescriptor: ToolDescriptor,
): SurfaceDelta | undefined {
  if (!approvedRecord?.descriptor) return undefined
  const diff = diffToolSchemas(approvedRecord.descriptor.inputSchema, observedDescriptor.inputSchema)
  return diff.truncated ? undefined : diff.surfaceDelta
}

/**
 * Pure comparison of `tools` against `serverEntry`'s approved catalog, with
 * per-tool fault isolation (a descriptor that fails to hash or redact is
 * quarantined as `new` with a synthetic `unhashable:` hash, never skipped and
 * never aborting the batch -- C3) and a hard cap on quarantine growth (M10:
 * beyond `maxQuarantine` no new entries are added and `capExceeded` is set).
 */
export function observeAgainst(
  serverEntry: ServerInventory,
  tools: readonly ToolDescriptor[],
  nowIso: string,
  maxQuarantine: number,
): Observation {
  const buckets = { known: [] as string[], new: [] as string[], changed: [] as string[] }
  const snapshot = new Map<string, QuarantineState>()
  let quarantined = serverEntry.quarantined
  let count = Object.keys(quarantined).length
  let capExceeded = false

  for (const tool of tools) {
    const { schemaHash, stored } = fingerprint(tool)
    const approvedRecord = serverEntry.approved[tool.name]

    if (approvedRecord && approvedRecord.schemaHash === schemaHash) {
      buckets.known.push(tool.name)
      snapshot.set(tool.name, 'known')
      continue
    }

    const state: 'new' | 'changed' = approvedRecord ? 'changed' : 'new'
    ;(state === 'new' ? buckets.new : buckets.changed).push(tool.name)
    snapshot.set(tool.name, state)

    const existing = quarantined[tool.name]
    if (existing && existing.schemaHash === schemaHash) continue // idempotent re-observe

    if (!existing && count >= maxQuarantine) {
      capExceeded = true // at cap: refuse to grow the store; caller fails closed
      continue
    }

    // Retention: the quarantined slot is REPLACED in place -- one observed
    // descriptor per tool, never a version history (see inventory-store.ts).
    const surfaceDelta = surfaceDeltaAgainstApproved(approvedRecord, stored.descriptor)
    quarantined = withKey<QuarantinedToolRecord>(quarantined, tool.name, {
      schemaHash,
      firstSeenAt: nowIso,
      state,
      descriptor: stored.descriptor,
      ...(stored.schemaTruncated ? { schemaTruncated: true } : {}),
      ...(surfaceDelta !== undefined ? { surfaceDelta } : {}),
    })
    if (!existing) count += 1
  }

  return {
    buckets,
    snapshot,
    nextServerEntry: { approved: serverEntry.approved, quarantined },
    capExceeded,
  }
}

/** The two synchronous lookups a decision needs from the inventory, built together. */
export interface InventorySnapshots {
  /** See `buildSnapshots`: the authoritative state map behind `stateOf`. */
  readonly states: ReadonlyMap<string, QuarantineState>
  /**
   * Surface direction for `changed` tools whose diff can be trusted (M5 wave
   * 6, O4). A tool ABSENT from this map has no established direction -- it is
   * not quarantined as `changed`, or the diff ran on degraded input -- which
   * `decide()` treats as "not provably narrower", never as "unchanged".
   */
  readonly deltas: ReadonlyMap<string, SurfaceDelta>
}

/**
 * Authoritative synchronous state map for `stateOf`: the UNION of the approved
 * catalog (`known`) overlaid by the persisted quarantine (`new`/`changed`), so
 * a quarantined tool stays quarantined even after a later `tools/list` omits
 * it (C4). Anything absent from both maps is `unknown`.
 *
 * Both maps are built in ONE pass over one `serverEntry`, and the caller
 * assigns them as one value: the surface delta is only ever read alongside the
 * state it belongs to, so a refresh that updated one and not the other would
 * let a decision see a stale direction for a fresh state. Two separate
 * builders would have made that a discipline; one return value makes it a
 * type.
 */
export function buildSnapshots(serverEntry: ServerInventory): InventorySnapshots {
  const states = new Map<string, QuarantineState>()
  const deltas = new Map<string, SurfaceDelta>()
  for (const name of Object.keys(serverEntry.approved)) states.set(name, 'known')
  for (const [name, record] of Object.entries(serverEntry.quarantined)) {
    states.set(name, record.state)
    const delta = trustedSurfaceDelta(serverEntry, name, record)
    if (delta !== undefined) deltas.set(name, delta)
  }
  return { states, deltas }
}

/**
 * The stored direction, but only when it was derived from schemas that were
 * stored WHOLE on both sides. A schema too large to persist is replaced by a
 * top-level summary (`schemaTruncated`), and a diff of two summaries can report
 * `neutral` for a change that widened something the summary dropped. Since
 * `decide()` withdraws an explicit `allow` on this signal, a confident answer
 * derived from degraded input is worse than no answer: no answer escalates,
 * a wrong `neutral` silently does not.
 */
function trustedSurfaceDelta(
  serverEntry: ServerInventory,
  toolName: string,
  record: QuarantinedToolRecord,
): SurfaceDelta | undefined {
  if (record.state !== 'changed' || record.surfaceDelta === undefined) return undefined
  if (record.schemaTruncated === true) return undefined
  if (serverEntry.approved[toolName]?.schemaTruncated === true) return undefined
  return record.surfaceDelta
}

export function quarantinedEntriesOf(serverName: string, serverEntry: ServerInventory): QuarantinedEntry[] {
  return Object.entries(serverEntry.quarantined).map(([toolName, record]) => ({
    serverName,
    toolName,
    state: record.state,
    firstSeenAt: record.firstSeenAt,
    shortHash: record.schemaHash.slice(0, SHORT_HASH_CHARS),
    ...(record.surfaceDelta !== undefined ? { surfaceDelta: record.surfaceDelta } : {}),
  }))
}

/** How `redactedDescriptorFor` treats `inputSchema` before persistence. */
export type SchemaStorageMode = 'drop-schema' | 'keep-schema'

/** A descriptor bounded for persistence, plus whether its schema was summarized. */
export interface StoredDescriptor {
  readonly descriptor: ToolDescriptor
  readonly schemaTruncated: boolean
}

/** Summary stored in place of an `inputSchema` that exceeds `MAX_STORED_SCHEMA_CHARS`. */
interface SchemaSummary {
  readonly schemaSummary: true
  readonly topLevelProperties: readonly string[]
  readonly required: readonly string[]
}

/**
 * Caps `description`, redacts the descriptor, and bounds it for persistence.
 *
 * `mode` (M4, reversing the M10 "always drop" decision): `'keep-schema'`
 * retains a redacted `inputSchema` -- capped at `MAX_STORED_SCHEMA_CHARS`;
 * past the cap it is replaced by a top-level summary (property names +
 * required) and `schemaTruncated` is set -- so the quarantine card can show a
 * structural diff instead of "hashes diverged". `'drop-schema'` preserves the
 * old M10 behavior. Either way the schema HASH is computed on the original,
 * uncapped descriptor, so bounding here never affects rug-pull detection.
 *
 * If the redacted result still serializes beyond `MAX_STORED_DESCRIPTOR_CHARS`,
 * annotations are dropped, then (last resort) the schema is summarized too.
 */
export function redactedDescriptorFor(tool: ToolDescriptor, mode: SchemaStorageMode): StoredDescriptor {
  const capped: ToolDescriptor = {
    name: tool.name,
    ...(tool.description !== undefined ? { description: capDescription(tool.description) } : {}),
    ...(mode === 'keep-schema' && tool.inputSchema !== undefined
      ? { inputSchema: tool.inputSchema }
      : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
  }
  // The redacted value is re-narrowed instead of double-cast (review M3):
  // `redact` preserves structure, but the type must be earned, not asserted.
  const redacted = toStoredToolDescriptor(redact(capped)) ?? { name: tool.name }
  return boundDescriptor(redacted)
}

/** Applies the byte caps: schema cap first, then annotation drop, then schema summary. */
function boundDescriptor(redacted: ToolDescriptor): StoredDescriptor {
  const bounded = withCappedSchema(redacted)
  if (serializedLength(bounded.descriptor) <= MAX_STORED_DESCRIPTOR_CHARS) return bounded

  const { annotations: _annotations, ...withoutAnnotations } = bounded.descriptor
  if (
    serializedLength(withoutAnnotations) <= MAX_STORED_DESCRIPTOR_CHARS ||
    withoutAnnotations.inputSchema === undefined
  ) {
    return { descriptor: withoutAnnotations, schemaTruncated: bounded.schemaTruncated }
  }
  return {
    descriptor: { ...withoutAnnotations, inputSchema: schemaSummaryOf(withoutAnnotations.inputSchema) },
    schemaTruncated: true,
  }
}

function withCappedSchema(descriptor: ToolDescriptor): StoredDescriptor {
  if (descriptor.inputSchema === undefined) return { descriptor, schemaTruncated: false }
  if (serializedLength(descriptor.inputSchema) <= MAX_STORED_SCHEMA_CHARS) {
    return { descriptor, schemaTruncated: false }
  }
  return {
    descriptor: { ...descriptor, inputSchema: schemaSummaryOf(descriptor.inputSchema) },
    schemaTruncated: true,
  }
}

/** JSON length of `value`; `Infinity` when it has no JSON form (forces the summary path). */
function serializedLength(value: unknown): number {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? Number.POSITIVE_INFINITY : text.length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** Bounded top-level summary of an oversized schema: property names + required. */
function schemaSummaryOf(schema: unknown): SchemaSummary {
  const shape = isPlainObject(schema) ? schema : {}
  const propertyNames = isPlainObject(shape['properties']) ? Object.keys(shape['properties']) : []
  const requiredNames = Array.isArray(shape['required'])
    ? shape['required'].filter((name): name is string => typeof name === 'string')
    : []
  return {
    schemaSummary: true,
    topLevelProperties: boundNames(propertyNames),
    required: boundNames(requiredNames),
  }
}

function boundNames(names: readonly string[]): readonly string[] {
  return names
    .slice(0, MAX_SCHEMA_SUMMARY_NAMES)
    .map((name) => name.slice(0, MAX_SCHEMA_SUMMARY_NAME_CHARS))
}

function capDescription(description: string): string {
  return description.length > MAX_STORED_DESCRIPTION_CHARS
    ? `${description.slice(0, MAX_STORED_DESCRIPTION_CHARS)}${DESCRIPTION_TRUNCATION_MARKER}`
    : description
}
