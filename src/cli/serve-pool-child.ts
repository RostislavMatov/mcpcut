import type { AgentRecord } from '../agents/schema.js'
import type { OpenPoolChild, OpenPoolChildResult, PoolChildReservation } from '../pool/children.js'
import { POOL_DEPARTURE_UNGRANTED } from '../pool/constants.js'
import type { UpstreamRevisionHint } from '../pool/handshake.js'
import type { ServerRecord } from '../registry/schema.js'
import type { RegistryStore } from '../registry/store.js'
import type { AgentRecordReader } from '../session/agent-watch.js'
import type { SessionContext } from '../transport/http/session.js'
import { REFUSAL_UNKNOWN_SERVER } from './serve-constants.js'
import type { ChildSessionOpener } from './serve-child.js'
import { REFUSAL_POOL_NO_AGENT } from './serve-pool-constants.js'
import type { ResidentSupervisor } from './serve-residents.js'

/**
 * Opening ONE child of one pool session: the registry lookup, the fresh agent
 * read and the choice of where the server comes from, which the pool cannot
 * make for itself (`src/pool/**` may not import `src/cli/**`).
 *
 *  - A stdio server comes from the resident supervisor (ADR-0016): the pool
 *    ATTACHES to this agent's held session, already running and negotiated.
 *  - If another pool session of the same agent holds it (`busy`), this pool
 *    gets an ordinary child of its own, which lives and dies with it.
 *  - An HTTP server is always an ordinary child (owner decision D5: HTTP is
 *    never held), negotiated by the pool on the revision its record asks for.
 *
 * Every "no" here is PE6 — a smaller pool, never a refused one — so it is a
 * `refused` result rather than a throw.
 */

export interface PoolChildOpenerInput {
  /** The pool session's context: its agent is the only one a child may serve. */
  readonly ctx: SessionContext
  readonly registry: Pick<RegistryStore, 'getServer'>
  readonly agents: AgentRecordReader
  /** This pool's opener, collecting the exact vault values its children get. */
  readonly openChildSession: ChildSessionOpener
  /** One stderr line in the pool's own voice. */
  readonly report: (message: string) => void
  /** Counts one child up (+1) or down (-1) against the process-wide ceiling. */
  readonly onChildCountChange: (delta: number) => void
  readonly residents: Pick<ResidentSupervisor, 'acquire'>
  /** One slot of the shared budget for an ordinary child (HTTP, or stdio when `busy`), or `null`. */
  readonly reserveProcessSlot: () => PoolChildReservation | null
  /** The exact values a held session was given, for this pool's redaction. */
  readonly onSecrets: (values: readonly string[]) => void
}

/** The refusal a stdio child gets when no process slot is left. */
const REFUSAL_POOL_FULL = 'pool-full'

export function createPoolChildOpener(input: PoolChildOpenerInput): OpenPoolChild {
  const { ctx } = input
  return async (server, start) => {
    const record = await input.registry.getServer(server)
    if (record === undefined) {
      return { status: 'refused', reason: REFUSAL_UNKNOWN_SERVER }
    }
    // Re-read rather than reuse the record this pool opened with. A child
    // may come up long after the pool did — and by then the agent may have
    // been granted this very server, or ungranted another. A stale record
    // would hand the child a grant matrix that never mentioned its server,
    // so its gate would deny everything until its own watch caught up. It is
    // the fail-closed direction too: a grant revoked in that window must not
    // produce a live child.
    const fresh = await input.agents.getAgent(ctx.agentName)
    // The same word for a withdrawn grant: between the child's own watch and
    // the pool's, the pool may still list a server the agent just lost. Said
    // here, before a supervisor entry or a child session is ever made.
    if (fresh === undefined || fresh.revokedAt !== undefined || !Object.hasOwn(fresh.grants, server)) {
      return { status: 'refused', reason: REFUSAL_POOL_NO_AGENT }
    }
    if (record.transport !== 'stdio') {
      return openClaimedChild(input, server, record, fresh)
    }
    const acquired = await input.residents.acquire(
      // The agent is the AUTHENTICATED one, and `createdAt` is from the read
      // above: a held session is only ever handed to its own agent (RS3).
      { agentName: ctx.agentName, agentCreatedAt: fresh.createdAt, serverName: server },
      record,
      start.deadline,
    )
    if (acquired.status === 'refused') {
      return { status: 'refused', reason: acquired.reason }
    }
    if (acquired.status === 'attached') {
      input.onSecrets(acquired.knownSecrets)
      return {
        status: 'opened',
        child: acquired.attachment.child,
        source: acquired.attachment.source,
        negotiated: acquired.discipline,
        lifetime: acquired.lifetime,
        departureReason: () => acquired.attachment.departureReason(),
      }
    }
    // `busy`: a second pool session of this agent. It gets a process of its
    // own, claimed against the budget like any ordinary child.
    return openClaimedChild(input, server, record, fresh)
  }
}

/**
 * An ordinary child, claimed against the service's shared budget first —
 * synchronously, before the open starts (P5), so two pools growing at once
 * cannot both take the last slot. The claim is handed back once the child is
 * counted (`onChildCountChange`) or refused.
 */
async function openClaimedChild(
  input: PoolChildOpenerInput,
  server: string,
  record: ServerRecord,
  fresh: AgentRecord,
): Promise<OpenPoolChildResult> {
  const slot = input.reserveProcessSlot()
  if (slot === null) {
    return { status: 'refused', reason: REFUSAL_POOL_FULL }
  }
  try {
    return await openOwnChild(input, server, record, fresh)
  } finally {
    slot.release()
  }
}

/** An ordinary child of this pool session: it lives and dies with it. */
async function openOwnChild(
  input: PoolChildOpenerInput,
  server: string,
  record: ServerRecord,
  fresh: AgentRecord,
): Promise<OpenPoolChildResult> {
  // The child knows nothing about the pool: its context is an ordinary
  // (agent, server) pair, so its gate, policy, quarantine, approvals and
  // decision records are byte-for-byte the per-server ones (PE11).
  const opened = await input.openChildSession(
    { agentName: input.ctx.agentName, serverName: server },
    { record, agent: fresh },
  )
  if ('error' in opened) {
    return { status: 'refused', reason: opened.error }
  }
  input.onChildCountChange(1)
  // Memoized like every other close in this codebase. `opened.close` is
  // already idempotent, but the DECREMENT is not, and it feeds the
  // process-wide session ceiling: a second call would quietly under-count
  // it and let more sessions through than the front allows.
  let closed: Promise<void> | null = null
  return {
    status: 'opened',
    child: {
      server,
      sessionId: opened.sessionId,
      sink: opened.sink,
      close: () => {
        closed ??= (async () => {
          input.onChildCountChange(-1)
          await opened.close()
        })()
        return closed
      },
    },
    source: opened.source,
    revisionHint: revisionHintOf(record),
    lifetime: 'pool',
    // The child's own watch ends it as `revoked` over a withdrawn grant (and
    // over a revoked agent, which the pool then closes over anyway): the
    // pool's word for both is `ungranted` (DR1).
    departureReason: () => (opened.endReason() === 'revoked' ? POOL_DEPARTURE_UNGRANTED : undefined),
  }
}

/**
 * Which negotiation a registry record asks for (RV1). The plane is the CLIENT
 * of every member and speaks its revision; an HTTP record the operator pinned
 * is taken at its word, everything else tries the handshake first.
 */
export function revisionHintOf(record: ServerRecord): UpstreamRevisionHint {
  if (record.transport === 'stdio') return 'legacy-first'
  if (record.protocol === 'sessionful') return 'sessionful-only'
  if (record.protocol === 'stateless') return 'stateless-only'
  return 'legacy-first'
}
