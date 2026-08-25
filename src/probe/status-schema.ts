import { z } from 'zod'
import { RESERVED_OBJECT_KEYS } from '../policy/constants.js'
import {
  MAX_RECORD_VALUE_CHARS,
  MAX_SERVERS_IN_REGISTRY,
  REGISTRY_SERVER_NAME_PATTERN,
} from '../registry/constants.js'

/**
 * zod schema for `server-status.json` (M5.5 p.1): the last known probe state
 * of every registered MCP server. One entry per server; absence of an entry
 * IS the `never-checked` state — it is synthesized on read and never
 * persisted (there is nothing to attribute or timestamp about "we never
 * looked").
 *
 * The `probing` entry doubles as the cross-process dedup marker: its
 * `probeStartedAt` lets a second would-be prober tell a live probe from a
 * crashed one (freshness window = probe timeout + slack, owned by the
 * orchestrator). The `error` string arrives ALREADY redacted — this document
 * trusts its writers (the probe pipeline) and never re-redacts.
 */

/** What a probe reached the server with; depends on transport/protocol (O4). */
export const PROBED_VIA_VALUES = ['initialize', 'tools/list'] as const
export type ProbedVia = (typeof PROBED_VIA_VALUES)[number]

/** What caused a probe to run (O2/O8); `adminName` when the trigger has one. */
export const PROBE_TRIGGER_VALUES = ['registration', 'lazy', 'refresh'] as const
export type ProbeTrigger = (typeof PROBE_TRIGGER_VALUES)[number]

const boundedString = z.string().min(1).max(MAX_RECORD_VALUE_CHARS)

export const probeInitiatorSchema = z.strictObject({
  trigger: z.enum(PROBE_TRIGGER_VALUES),
  adminName: boundedString.optional(),
})

export type ProbeInitiator = z.infer<typeof probeInitiatorSchema>

const probingEntrySchema = z.strictObject({
  status: z.literal('probing'),
  probeStartedAt: z.iso.datetime(),
  initiator: probeInitiatorSchema,
})

const aliveEntrySchema = z.strictObject({
  status: z.literal('alive'),
  probedVia: z.enum(PROBED_VIA_VALUES),
  /** Time to the first valid probe response (O4); named for the common case. */
  initializeLatencyMs: z.number().finite().nonnegative(),
  probedAt: z.iso.datetime(),
  initiator: probeInitiatorSchema,
})

/** `error` ≠ `unreachable` ≠ `vault-refused`: three distinct verdicts (plan risk table). */
const failedEntrySchema = z.strictObject({
  status: z.enum(['error', 'unreachable', 'vault-refused']),
  /** Human-readable cause; pre-redacted by the probe pipeline, stored verbatim. */
  error: boundedString,
  probedVia: z.enum(PROBED_VIA_VALUES).optional(),
  probedAt: z.iso.datetime(),
  initiator: probeInitiatorSchema,
})

/** One persisted per-server entry (never `never-checked`, see module docs). */
export const storedServerStatusSchema = z.discriminatedUnion('status', [
  probingEntrySchema,
  aliveEntrySchema,
  failedEntrySchema,
])

export type ProbingServerStatus = z.infer<typeof probingEntrySchema>
export type StoredServerStatus = z.infer<typeof storedServerStatusSchema>

/** Synthesized on read for servers with no entry; never written to disk. */
export type NeverCheckedStatus = { readonly status: 'never-checked' }
export const NEVER_CHECKED: NeverCheckedStatus = { status: 'never-checked' }

/** What a status read yields: a stored entry, or the synthetic never-checked. */
export type ServerStatus = StoredServerStatus | NeverCheckedStatus

/** Full `server-status.json` document. */
export const serverStatusFileSchema = z.strictObject({
  version: z.literal(1),
  servers: z
    .record(
      z.string().regex(REGISTRY_SERVER_NAME_PATTERN, 'server name must be a registry-style name'),
      storedServerStatusSchema,
    )
    .superRefine((servers, ctx) => {
      const keys = Object.getOwnPropertyNames(servers)
      if (keys.length > MAX_SERVERS_IN_REGISTRY) {
        ctx.addIssue({ code: 'custom', message: `too many servers: max ${MAX_SERVERS_IN_REGISTRY}` })
      }
      for (const key of keys) {
        if (RESERVED_OBJECT_KEYS.includes(key)) {
          ctx.addIssue({ code: 'custom', message: `reserved key "${key}" is not allowed in servers`, path: [key] })
        }
      }
    }),
})

export type ServerStatusFile = z.infer<typeof serverStatusFileSchema>

/** Discriminated result of validating a raw document. Never throws. */
export type ParseServerStatusFileResult =
  | { readonly ok: true; readonly file: ServerStatusFile }
  | { readonly ok: false; readonly error: z.ZodError }

/**
 * Validates a raw, untrusted document (parsed JSON from `state.db`). The only
 * record in this document is `servers`, whose zod rebuild silently DROPS a
 * `__proto__` own-key before `superRefine` can see it (the fail-open shape
 * documented in `policy/schema.ts` / `registry/schema.ts`) — hence the
 * pre-scan of the raw map's own keys; every nested object is a `strictObject`
 * and rejects reserved keys as unrecognized on its own.
 */
export function parseServerStatusFile(value: unknown): ParseServerStatusFileResult {
  const reserved = rejectReservedServerKeys(value)
  if (reserved !== null) {
    return { ok: false, error: reserved }
  }
  const result = serverStatusFileSchema.safeParse(value)
  return result.success ? { ok: true, file: result.data } : { ok: false, error: result.error }
}

function rejectReservedServerKeys(value: unknown): z.ZodError | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const servers = (value as Record<string, unknown>).servers
  if (typeof servers !== 'object' || servers === null) {
    return null
  }
  for (const key of Object.getOwnPropertyNames(servers)) {
    if (RESERVED_OBJECT_KEYS.includes(key)) {
      return new z.ZodError([
        { code: 'custom', message: `reserved key "${key}" is not allowed in servers`, path: ['servers', key] },
      ])
    }
  }
  return null
}
