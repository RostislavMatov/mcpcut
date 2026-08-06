import { detectInitializeBytes } from '../protocol/mcp.js'
import type { SessionHandle } from '../session/core.js'
import type { MessageSource } from '../transport/message.js'
import { statelessInitializeRefusal } from './connect-constants.js'
import { guardStatelessInitialize } from './connect-source.js'

/**
 * Session-model mismatch guard for one `connect` session against a
 * `protocol: 'stateless'` upstream (ADR-0002 — the control plane transports
 * both session models and translates between neither).
 *
 * The refusal is decided from the client's FIRST message and that message is
 * never delivered, so the upstream receives zero bytes. Split out of
 * `connect-cmd.ts` because it is a self-contained little state machine —
 * three moving parts (the wrapped source, the session it has to end, and the
 * exit-code flag) that the command itself only ever wires together.
 *
 * The guard is built before the session exists (the wrapped source has to be
 * handed to `createSession`), so `bind` supplies the session afterwards and
 * honors a refusal that already fired.
 */
export interface MismatchGuard {
  /** Wraps the client source so a sessionful handshake never reaches the upstream. */
  wrap(source: MessageSource): MessageSource
  /** Supplies the session to end — it does not exist when the guard is built. */
  bind(session: SessionHandle): void
  /** True once the refusal fired; the command turns this into its exit code. */
  hasTripped(): boolean
}

export function createMismatchGuard(
  serverName: string,
  onDiagnostic: (line: string) => void,
): MismatchGuard {
  let hasTripped = false
  let session: SessionHandle | null = null

  return {
    hasTripped: () => hasTripped,
    bind: (next: SessionHandle) => {
      session = next
      if (hasTripped) {
        void session.close('closed')
      }
    },
    wrap: (source: MessageSource) =>
      guardStatelessInitialize(source, detectInitializeBytes, () => {
        hasTripped = true
        onDiagnostic(statelessInitializeRefusal(serverName))
        void session?.close('closed')
      }),
  }
}
