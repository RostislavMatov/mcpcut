import { canonicalJson, sha256Hex } from '../policy/hash.js'
import { classify } from '../protocol/classify.js'
import { createPoolCorrelator } from '../pool/correlator.js'
import { createPoolFanout } from '../pool/fanout.js'
import { negotiateUpstream, type PoolMemberDiscipline } from '../pool/handshake.js'
import { fanoutTagOf } from '../pool/multiplexer-frames.js'
import type { StdioServerRecord } from '../registry/schema.js'
import { clientMessage } from '../transport/message.js'
import type { ResolveVaultRefsResult } from '../vault/resolve.js'
import { createChildSessionOpener, type ChildSessionDeps, type OpenedChildSession } from './serve-child.js'
import { POOL_RESIDENT_NEGOTIATION_PENDING } from './serve-residents-constants.js'
import { START_ABORTED_REASON, type OpenStartResult, type StartJob } from './serve-residents-start.js'

/**
 * Opening ONE held session and introducing the plane to its server, before
 * any agent is attached (ADR-0016). The same child session a pool opens —
 * `createChildSessionOpener`, the same gate, policy, approvals and journal —
 * plus the negotiation a pool would otherwise run itself (RV1-RV2), over a
 * PRIVATE correlator and fan-out: no pool exists yet to own one, and the ids
 * minted here are all answered before the first attachment.
 *
 * The fingerprint is what an attachment later checks (RS4): the sha256 of the
 * record and of the values its env resolved to. A rotated vault secret changes
 * it, so the next attachment restarts the process rather than hand an agent a
 * server still running on the old secret. The values themselves are never
 * logged, never journaled, and leave this file only as the redaction list.
 */

export interface ResidentOpenDeps {
  /** What every child session is built from (`serve-cmd.ts`'s `shared`). */
  readonly childDeps: ChildSessionDeps
  readonly planeVersion: string
  readonly now: () => number
}

/** How `serve` fingerprints a record: the record, and the values its env resolved to. */
export function fingerprintOf(record: StdioServerRecord, values: Readonly<Record<string, string>>): string {
  return sha256Hex(canonicalJson({ record, values }))
}

/**
 * The env a record resolves to right now — exactly what `buildServerEnv`
 * asks the resolver, so a fingerprint taken at attach time matches the one
 * taken at start.
 */
export function resolveDeclaredEnv(
  childDeps: ChildSessionDeps,
  record: StdioServerRecord,
): Promise<ResolveVaultRefsResult> {
  return childDeps.upstream.resolveRefs({ ...(record.env ?? {}) })
}

export function createResidentOpenStart(
  deps: ResidentOpenDeps,
): (job: StartJob, deadline: number, signal: AbortSignal) => Promise<OpenStartResult> {
  return async (job, deadline, signal) => {
    if (signal.aborted) return { ok: false, reason: START_ABORTED_REASON }
    let values: Readonly<Record<string, string>> | null = null
    const opener = createChildSessionOpener({
      ...deps.childDeps,
      upstream: {
        ...deps.childDeps.upstream,
        resolveRefs: async (declared) => {
          const result = await deps.childDeps.upstream.resolveRefs(declared)
          if (result.status === 'resolved') values = result.values
          return result
        },
      },
    })
    const opened = await opener(
      { agentName: job.pair.agentName, serverName: job.pair.serverName },
      { record: job.record, agent: job.agent },
    )
    if ('error' in opened) return { ok: false, reason: opened.error }
    // An abort that fired during the spawn has no listener to hear it: the
    // one in `negotiate` is added after. Checked here, or a shutdown would
    // wait out the whole start budget (security review LOW-1).
    if (signal.aborted) {
      await opened.close()
      return { ok: false, reason: START_ABORTED_REASON }
    }
    const outcome = await negotiate(deps, job, opened, deadline, signal)
    if (!outcome.ok) {
      await opened.close()
      return outcome
    }
    const resolved = values ?? {}
    return {
      ok: true,
      opened,
      discipline: outcome.discipline,
      fingerprint: fingerprintOf(job.record, resolved),
      knownSecrets: Object.values(resolved),
    }
  }
}

type Negotiated =
  | { readonly ok: true; readonly discipline: PoolMemberDiscipline }
  | { readonly ok: false; readonly reason: string }

/** The handshake-first negotiation over a private fan-out; fails fast on an end or an abort. */
async function negotiate(
  deps: ResidentOpenDeps,
  job: StartJob,
  opened: OpenedChildSession,
  deadline: number,
  signal: AbortSignal,
): Promise<Negotiated> {
  const server = job.pair.serverName
  const correlator = createPoolCorrelator(POOL_RESIDENT_NEGOTIATION_PENDING)
  // A start's own timeouts are reported as the start's outcome, not here.
  const fanout = createPoolFanout({ correlator, timeoutMs: deadline - deps.now(), onTimeout: () => undefined })
  let hasEnded = false
  // Temporary handlers: the held session registers its own, for good, once
  // this returns — the memory pipe keeps one handler per channel.
  opened.source.onMessage((message) => {
    const classified = classify(message.bytes.toString('utf8'))
    if (classified.kind !== 'response') return
    if (correlator.settle(server, classified.id).kind === 'fanout') {
      fanout.settle(server, fanoutTagOf(classified.id), classified.raw)
    }
  })
  opened.source.onEnd(() => {
    hasEnded = true
    fanout.abandon(server)
  })
  const onAbort = (): void => fanout.abandon(server)
  signal.addEventListener('abort', onAbort, { once: true })
  const child = { server, sessionId: opened.sessionId, sink: opened.sink, close: () => opened.close() }
  try {
    const outcome = await negotiateUpstream({
      ask: (tag, buildLine, timeoutMs) => fanout.ask(child, tag, buildLine, { timeoutMs }),
      notify: (line) => opened.sink.write(clientMessage(Buffer.from(line, 'utf8'))),
      hint: 'legacy-first',
      deadline,
      now: deps.now,
      planeVersion: deps.planeVersion,
    })
    if (signal.aborted) return { ok: false, reason: START_ABORTED_REASON }
    if (hasEnded) return { ok: false, reason: 'ended-during-start' }
    return outcome
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
