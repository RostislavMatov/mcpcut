import { ulid } from 'ulid'
import { redact } from '../redact/redact.js'
import type { ClientServerDirection, JournalRecord } from './record.js'

/**
 * The probe-record vocabulary and builder: what a `kind: 'probe'` journal
 * record says about one server probe (M5.5 п.1, ADR-0008 §6). One probe =
 * ONE flat record — the fact and outcome, never the exchanged traffic (O6).
 *
 * Split out of `record.ts` the same way `decision.ts`/`decision-info.ts`
 * were: `record.ts` owns the traffic-record builder and stays the contract
 * point (it re-exports these types), this module owns the probe side.
 *
 * Layering: the journal must not depend on `src/probe/**` (the probe engine
 * depends on the journal, not the other way round), so the trigger/via/
 * outcome unions are declared here in journal terms. `src/probe/journal-probe.ts`
 * is the one adapter that maps a `ProbeResult` onto this shape.
 *
 * Attribution is separable from agent traffic BY CONSTRUCTION: the kind is
 * its own, the reserved `plane_probe` session id can never be a registry
 * server name, and none of the decision-record fields (`agentName`, grants,
 * outcome filters) ever appear on a probe record — a probe must never be
 * counted as something an agent did (ADR-0008 §6).
 */

/** Direction a probe record is stamped with: the plane spoke as the client. */
const PROBE_DIRECTION: ClientServerDirection = 'client→server'

/** What caused the probe to run (owner decision O2/O8). */
export type ProbeRecordTrigger = 'registration' | 'lazy' | 'refresh'

/** Who asked. `adminName` is present when the trigger carries one (UI view, CLI admin token). */
export interface ProbeRecordInitiator {
  readonly trigger: ProbeRecordTrigger
  readonly adminName?: string
}

/** Final disposition of one probe (mirrors the engine's `ProbeResult` statuses). */
export type ProbeRecordOutcome = 'alive' | 'error' | 'unreachable' | 'vault-refused'

/** What the probe reached the server with — transport/protocol dependent (O4). */
export type ProbeRecordVia = 'initialize' | 'tools/list'

/**
 * Everything a `probe`-kind record says. Flat and short by design: the
 * exchanged `initialize`/`tools/list` traffic never lands in the journal
 * (O6), only these fields do — as the record's `payload`, so the existing
 * search, UI journal and export surfaces render them with no special casing.
 */
export interface ProbeRecordInfo {
  readonly serverName: string
  readonly initiator: ProbeRecordInitiator
  readonly outcome: ProbeRecordOutcome
  /** Absent on failures where no probe message was answered. */
  readonly probedVia?: ProbeRecordVia
  /** Time to the first valid probe response, whole ms (O4). Present only when alive. */
  readonly initializeLatencyMs?: number
  /** Human-readable cause on failure. Arrives pre-redacted; re-redacted here anyway. */
  readonly error?: string
}

export interface BuildProbeRecordInput {
  /** The reserved probe session id (`PROBE_SESSION_ID`); a parameter so the journal stays probe-agnostic. */
  readonly sessionId: string
  readonly probe: ProbeRecordInfo
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  readonly clock?: () => number
  /** Exact secret values the probe's upstream was given (vault-resolved material). */
  readonly knownSecrets?: readonly string[]
}

/**
 * Builds a frozen, redacted `kind: 'probe'` journal record. The probe info
 * travels as the record's `payload` and goes through `redact()` whole — the
 * single path into the journal — even though the engine already writes
 * redacted messages: `error` embeds server-influenced text, `adminName` is
 * read back from stored admin records, and a choke point here covers every
 * present and future producer the same way `decision.ts` covers `actor`.
 *
 * `method` mirrors `probedVia` and `durationMs` mirrors the latency, so the
 * generic journal surfaces (method filter, latency column) work on probe
 * records with no probe-specific code.
 */
export function buildProbeRecord(input: BuildProbeRecordInput): JournalRecord {
  const now = input.clock ?? Date.now
  const knownSecrets = input.knownSecrets ?? []
  const payload = redact(flatInfoOf(input.probe), knownSecrets)
  const probedVia = input.probe.probedVia
  const latencyMs = input.probe.initializeLatencyMs

  const record: JournalRecord = {
    id: ulid(),
    ts: new Date(now()).toISOString(),
    sessionId: input.sessionId,
    direction: PROBE_DIRECTION,
    kind: 'probe',
    payload,
    ...(probedVia !== undefined ? { method: probedVia } : {}),
    ...(latencyMs !== undefined ? { durationMs: Math.round(latencyMs) } : {}),
  }
  return Object.freeze(record)
}

/**
 * The payload object, assembled field by field so an absent optional stays
 * ABSENT instead of becoming an `undefined`-valued key (the codebase's
 * "absent, not null" convention — an absent error is a fact, not a gap).
 */
function flatInfoOf(probe: ProbeRecordInfo): Record<string, unknown> {
  return {
    serverName: probe.serverName,
    initiator: {
      trigger: probe.initiator.trigger,
      ...(probe.initiator.adminName !== undefined ? { adminName: probe.initiator.adminName } : {}),
    },
    outcome: probe.outcome,
    ...(probe.probedVia !== undefined ? { probedVia: probe.probedVia } : {}),
    ...(probe.initializeLatencyMs !== undefined
      ? { initializeLatencyMs: Math.round(probe.initializeLatencyMs) }
      : {}),
    ...(probe.error !== undefined ? { error: probe.error } : {}),
  }
}
