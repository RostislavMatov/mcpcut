import { withStatelessMeta, type StatelessClientMeta } from '../protocol/mcp-stateless.js'
import { clientMessage, type McpMessage } from '../transport/message.js'
import type { PoolChild } from './children.js'

/**
 * A pool member that speaks 2026-07-28 (ADR-0015 amendment 2026-09-23, RV3):
 * the same child, with a sink that stamps every frame the pool sends it with
 * the `_meta` that revision requires.
 *
 * ONE place for it on purpose. Every write to a member — a routed call, a
 * cancellation, a fan-out list — goes through `child.sink`, so a path that
 * forgot the stamp cannot exist (the lesson of the phase-3 CRITICAL, where one
 * path of several forgot a release). The HTTP header `MCP-Protocol-Version` is
 * mirrored from the stamped body by the transport, so header and body agree
 * by construction.
 *
 * Applied only AFTER negotiation: the handshake must not be stamped, and
 * `server/discover` stamps itself.
 */

/** A frame the pool tried to send a stateless member that is not a request or notification. */
export class PoolMemberFrameError extends Error {
  constructor(server: string) {
    super(`refused to send server ${server} a frame that is not a request or notification`)
    this.name = 'PoolMemberFrameError'
  }
}

export function statelessMember(child: PoolChild, client: StatelessClientMeta): PoolChild {
  return {
    // `close` is carried over as the SAME function: wrapping it would lose the
    // memo that keeps the ceiling's decrement to one.
    ...child,
    sink: {
      write(message: McpMessage): Promise<void> {
        const stamped = withStatelessMeta(message.bytes.toString('utf8'), client)
        if (stamped === null) {
          return Promise.reject(new PoolMemberFrameError(child.server))
        }
        return child.sink.write(clientMessage(Buffer.from(stamped, 'utf8')))
      },
      dispose: () => child.sink.dispose(),
    },
  }
}
