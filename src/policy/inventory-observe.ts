import type { QuarantineState } from '../journal/record.js'
import type { ToolDescriptor } from '../protocol/mcp.js'
import { redact, redactString } from '../redact/redact.js'
import { MAX_STORED_DESCRIPTION_CHARS, MAX_STORED_DESCRIPTOR_CHARS } from './constants.js'
import { hashToolSchema } from './hash.js'
import {
  type QuarantinedToolRecord,
  type ServerInventory,
  emptyMap,
  withKey,
} from './inventory-store.js'

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
}

export interface Observation {
  readonly buckets: { readonly known: string[]; readonly new: string[]; readonly changed: string[] }
  readonly snapshot: ReadonlyMap<string, QuarantineState>
  readonly nextServerEntry: ServerInventory
  /** `true` when the per-server quarantine cap was hit; caller marks the catalog untrusted. */
  readonly capExceeded: boolean
}

/** Fingerprints one tool, isolating any hash/redact fault as an "unhashable" quarantine (never a throw). */
function fingerprint(tool: ToolDescriptor): { schemaHash: string; descriptor: ToolDescriptor } {
  try {
    return { schemaHash: hashToolSchema(tool), descriptor: redactedDescriptorFor(tool) }
  } catch {
    const safeName = safeToolName(tool.name)
    return {
      schemaHash: `${UNHASHABLE_PREFIX}${safeName}`,
      descriptor: { name: tool.name, description: '[UNHASHABLE DESCRIPTOR]' },
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
    const { schemaHash, descriptor } = fingerprint(tool)
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

    quarantined = withKey<QuarantinedToolRecord>(quarantined, tool.name, {
      schemaHash,
      firstSeenAt: nowIso,
      state,
      descriptor,
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

/**
 * Authoritative synchronous state map for `stateOf`: the UNION of the approved
 * catalog (`known`) overlaid by the persisted quarantine (`new`/`changed`), so
 * a quarantined tool stays quarantined even after a later `tools/list` omits
 * it (C4). Anything absent from both maps is `unknown`.
 */
export function buildSnapshot(serverEntry: ServerInventory): Map<string, QuarantineState> {
  const snapshot = new Map<string, QuarantineState>()
  for (const name of Object.keys(serverEntry.approved)) snapshot.set(name, 'known')
  for (const [name, record] of Object.entries(serverEntry.quarantined)) snapshot.set(name, record.state)
  return snapshot
}

export function quarantinedEntriesOf(serverName: string, serverEntry: ServerInventory): QuarantinedEntry[] {
  return Object.entries(serverEntry.quarantined).map(([toolName, record]) => ({
    serverName,
    toolName,
    state: record.state,
    firstSeenAt: record.firstSeenAt,
    shortHash: record.schemaHash.slice(0, SHORT_HASH_CHARS),
  }))
}

/**
 * Caps `description`, DROPS `inputSchema` (the schema hash already pins it, so
 * the stored copy -- for human display only -- never needs it, per M10), and
 * redacts the descriptor before it is persisted. If the redacted result still
 * serializes beyond `MAX_STORED_DESCRIPTOR_CHARS`, annotations are dropped too.
 */
export function redactedDescriptorFor(tool: ToolDescriptor): ToolDescriptor {
  const capped: ToolDescriptor = {
    name: tool.name,
    ...(tool.description !== undefined ? { description: capDescription(tool.description) } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
  }
  const redacted = redact(capped) as unknown as ToolDescriptor
  if (JSON.stringify(redacted).length <= MAX_STORED_DESCRIPTOR_CHARS) return redacted
  const { annotations, ...withoutAnnotations } = redacted
  return withoutAnnotations
}

function capDescription(description: string): string {
  return description.length > MAX_STORED_DESCRIPTION_CHARS
    ? `${description.slice(0, MAX_STORED_DESCRIPTION_CHARS)}${DESCRIPTION_TRUNCATION_MARKER}`
    : description
}
