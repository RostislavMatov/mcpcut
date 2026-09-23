import type { PoolChild } from '../pool/children.js'
import { POOL_DEPARTURE_UNGRANTED } from '../pool/constants.js'
import type { PoolMemberDiscipline } from '../pool/handshake.js'
import type { SessionEndReason } from '../session/core.js'
import type { McpMessage, MessageSource } from '../transport/message.js'
import type { OpenedChildSession } from './serve-child.js'

/**
 * A HELD child session (ADR-0016, RS1, RS5): one ordinary per-server session
 * for an (agent, stdio server) pair, owned by the resident supervisor rather
 * than by any pool session, which pool sessions of that agent ATTACH to and
 * DETACH from.
 *
 * The session is the unit that keeps living — its gate, policy, approvals,
 * journal and its own agent watch run through every attachment and between
 * them — so whatever the server says with no agent attached (its stderr, a
 * notification, the handshake at start) is journaled by the session itself.
 *
 * The one invariant this file exists for: a detached attachment can never
 * reach the session again, and never hear from it. Each `attach()` hands out
 * NEW objects — a `PoolChild` whose sink writes only while that attachment is
 * the current one, and a source facade whose handlers are that attachment's
 * own. After release, a write through the old sink is a no-op: otherwise a
 * `notifications/cancelled` or a retried call from a closed pool session
 * would EXECUTE on the server under somebody else's attachment. And a frame
 * from the session reaches only the current attachment's handler, so a late
 * reply can never be credited to a pool session that did not ask for it —
 * the CRITICAL of phase 3, one level down.
 *
 * Only one attachment at a time: a stdio process is one conversation.
 */

export interface HeldSessionInfo {
  readonly server: string
  /** How the plane already negotiated with this server; attachments skip it. */
  readonly discipline: PoolMemberDiscipline
}

export interface HeldAttachment {
  /** Sink guarded by this attachment; `close({dirty})` releases it. */
  readonly child: PoolChild
  /** This attachment's own handlers onto the session's frames and end. */
  readonly source: MessageSource
  /** `ungranted` when the session's own watch ended it over a withdrawn grant (DR1). */
  departureReason(): string | undefined
}

export interface HeldSessionHooks {
  /**
   * The current attachment let go. `dirty` = the pool still had requests in
   * flight here, so the session must not be attached again (RS5). Awaited by
   * the attachment's `close()`: a pool session that closes waits for what its
   * release decided, the way it waited for its children before.
   */
  onReleased(dirty: boolean): Promise<void>
  /** The session ended on its own terms (or was closed); `wasAttached` = mid-attachment. */
  onEnded(reason: SessionEndReason | null, wasAttached: boolean): void
}

export interface HeldSession {
  readonly sessionId: string
  readonly info: HeldSessionInfo
  /** A new attachment, or `null` while another one holds it or once it ended. */
  attach(): HeldAttachment | null
  readonly isAttached: boolean
  readonly hasEnded: boolean
  endReason(): SessionEndReason | null
  /** Closes the session itself, and with it the process and the journal. */
  close(): Promise<void>
}

/** One attachment's handlers; `null` until the pool registers its own. */
interface Attachment {
  onMessage: ((message: McpMessage) => void) | null
  onEnd: (() => void) | null
}

export function createHeldSession(
  opened: OpenedChildSession,
  info: HeldSessionInfo,
  hooks: HeldSessionHooks,
): HeldSession {
  let current: Attachment | null = null
  let hasEnded = false

  // Registered ONCE, for the life of the session: the supervisor's, never a
  // pool's. The memory pipe allows one handler per channel.
  opened.source.onMessage((message) => {
    // No attachment: dropped here, and already journaled by the session's gate.
    current?.onMessage?.(message)
  })
  opened.source.onEnd(() => {
    if (hasEnded) return
    hasEnded = true
    const attached = current
    attached?.onEnd?.()
    hooks.onEnded(opened.endReason(), attached !== null)
  })

  function attach(): HeldAttachment | null {
    if (hasEnded || current !== null) return null
    const mine: Attachment = { onMessage: null, onEnd: null }
    current = mine
    /** THE lock: this attachment still speaks for the session. */
    const isCurrent = (): boolean => current === mine && !hasEnded
    let released: Promise<void> | null = null

    const child: PoolChild = {
      server: info.server,
      sessionId: opened.sessionId,
      sink: {
        write: (message) => (isCurrent() ? opened.sink.write(message) : Promise.resolve()),
        // The session's sink belongs to the session, not to one attachment.
        dispose: () => undefined,
      },
      close: (options) => {
        released ??= (async () => {
          if (current !== mine) return
          current = null
          // After an end the supervisor already heard `onEnded`; a release on
          // top of it would restart the server a second time.
          if (hasEnded) return
          await hooks.onReleased(options?.dirty === true)
        })()
        return released
      },
    }
    const source: MessageSource = {
      onMessage: (handler) => {
        mine.onMessage = handler
      },
      onError: () => undefined,
      onEnd: (handler) => {
        mine.onEnd = handler
        // The session died while this attachment was being wired up: tell the
        // late listener anyway, as the memory pipe does (`serve-pipe.ts`).
        if (hasEnded && current === mine) handler()
      },
      dispose: () => {
        mine.onMessage = null
        mine.onEnd = null
      },
    }
    return {
      child,
      source,
      departureReason: () => (opened.endReason() === 'revoked' ? POOL_DEPARTURE_UNGRANTED : undefined),
    }
  }

  return {
    sessionId: opened.sessionId,
    info,
    attach,
    get isAttached(): boolean {
      return current !== null && !hasEnded
    },
    get hasEnded(): boolean {
      return hasEnded
    },
    endReason: () => opened.endReason(),
    close: () => opened.close(),
  }
}
