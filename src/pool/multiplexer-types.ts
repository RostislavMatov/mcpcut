import type { PoolRecordInfo } from '../journal/pool-record.js'
import type { McpMessage } from '../transport/message.js'
import type { PoolCatalog } from './catalog.js'
import type { PoolChildren } from './children.js'
import type { PoolCorrelator } from './correlator.js'
import type { PoolFanout } from './fanout.js'
import type { PoolWatch } from './watch.js'

/**
 * The contract of the pool multiplexer (`multiplexer.ts`), split out for the
 * <400-line file rule; `multiplexer.ts` re-exports both types.
 */

export interface PoolMultiplexerDeps {
  readonly agentName: string
  /** The plane's own version, for `serverInfo`; there is no version literal under `src/`. */
  readonly planeVersion: string
  readonly children: PoolChildren
  readonly catalog: PoolCatalog
  readonly correlator: PoolCorrelator
  /** Settles the replies to the plane's OWN upstream requests (`fanout.ts`). */
  readonly fanout: PoolFanout
  readonly watch: PoolWatch
  /** One `kind:'pool'` record. Wrapped by the caller; guarded again here. */
  readonly journal: (info: PoolRecordInfo) => void
  /** Everything the pool sends the agent (already framed). */
  readonly toAgent: (bytes: Buffer) => void
  readonly onError: (error: unknown) => void
}

export interface PoolMultiplexer {
  /** One frame from the agent. Never throws. */
  handleAgentFrame(bytes: Buffer): void
  /** One frame from a child session. Never throws. */
  handleChildFrame(server: string, message: McpMessage): void
  /**
   * The agent stopped waiting for this request without a cancel — its HTTP
   * request closed (decision M36, phase B). The child holding the request
   * hears so; a call it holds for a human is withdrawn. Never throws.
   */
  abandonAgentRequest(bytes: Buffer): void
  /**
   * A child left the pool, for ANY reason — ungranted, its own session ended,
   * or it stopped answering. Answers every call the agent had in flight there
   * and forgets them. Idempotent, and must be called on every departure: see
   * its implementation for what goes wrong when one path forgets.
   */
  releaseServer(server: string): void
  /** Called by the watch when membership moved; closes what left, wakes the agent. */
  onMembershipChanged(granted: readonly string[]): Promise<void>
  close(): Promise<void>
}
