import { buildUpstreamInitialize, readUpstreamInitializeResult, UPSTREAM_INITIALIZED_LINE } from './initialize.js'
import { clientMessage } from '../transport/message.js'
import type { PoolChild } from './children.js'
import type { PoolFanout } from './fanout.js'
import type { UpstreamInitializeInfo } from './initialize.js'
import { LATEST_SESSIONFUL_PROTOCOL_VERSION } from '../protocol/mcp.js'

/**
 * The handshake the plane opens to one upstream of a pool (ADR-0015 §4).
 *
 * A pool address answers the AGENT's `initialize` itself (PE12), so nothing
 * the agent sends reaches an upstream — which means the plane has to introduce
 * itself to each one, in its own name, or a server that follows the spec will
 * refuse every request that follows. This is that introduction, and it is also
 * where PE3 is actually enforced: the plane declares `capabilities: {}`, so a
 * server told of no sampling, elicitation or roots will not initiate any.
 *
 * `null` means "this server did not come up": an unreadable result, a protocol
 * revision the plane cannot speak, or no answer at all. The caller opens the
 * pool without it (PE6) — less access, never a refusal of the whole pool.
 */

/** Fan-out tag the handshake's reply is reported under. */
const HANDSHAKE_TAG = 'initialize'

export async function performUpstreamHandshake(
  fanout: PoolFanout,
  child: PoolChild,
  planeVersion: string,
): Promise<UpstreamInitializeInfo | null> {
  const raw = await fanout.ask(child, HANDSHAKE_TAG, (id) =>
    buildUpstreamInitialize(id, LATEST_SESSIONFUL_PROTOCOL_VERSION, planeVersion),
  )
  if (raw === null) {
    return null
  }
  const info = readUpstreamInitializeResult(raw)
  if (info === null) {
    return null
  }

  // The notification that closes the handshake. Sent and not awaited: it is a
  // notification, so there is nothing to wait for, and a server that ignores
  // it is still a server the plane can list.
  await child.sink.write(clientMessage(Buffer.from(UPSTREAM_INITIALIZED_LINE, 'utf8')))
  return info
}
