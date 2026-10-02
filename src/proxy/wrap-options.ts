import type { Readable, Writable } from 'node:stream'
import type { JournalSinkOptions } from '../journal/sink.js'
import type { PolicyProvider } from '../policy/reload.js'
import type { Policy } from '../policy/schema.js'
import type { GateAgentScope } from './gate.js'
import type { PendingApprovalNotice } from './gate-types.js'
import type { AskClientOptions } from './client-approval.js'

/**
 * Everything `runWrap` can be told, split out of `wrap.ts` for the 400-line
 * file rule; `wrap.ts` re-exports it, so importers are unchanged.
 */
export interface RunWrapOptions {
  /** Journal directory. Defaults to JOURNAL_DIR via createJournalSink. */
  readonly dir?: string
  /** Injectable session id, for deterministic tests. Defaults to a fresh ulid(). */
  readonly sessionId?: string
  /** Injectable clock for the record builder, for deterministic tests. */
  readonly now?: () => number
  /** Client-facing input stream. Defaults to process.stdin. */
  readonly stdin?: Readable
  /** Client-facing output stream. Defaults to process.stdout. */
  readonly stdout?: Writable
  /** Client-facing stderr passthrough stream. Defaults to process.stderr. */
  readonly stderr?: Writable
  /** Working directory for the spawned server. */
  readonly cwd?: string
  /**
   * Grace period after forwarding a shutdown signal to the child before
   * escalating to SIGKILL. Defaults to SIGKILL_ESCALATION_MS. Injectable so
   * tests do not have to wait out the real grace period.
   */
  readonly killEscalationMs?: number
  /**
   * Max time to wait for the server→client relay to drain after the child
   * has exited, before proceeding with shutdown anyway. Defaults to
   * RELAY_DRAIN_TIMEOUT_MS. Injectable so tests do not have to wait out the
   * real timeout.
   */
  readonly relayDrainTimeoutMs?: number
  /**
   * Pre-loaded, already-validated policy. Its presence is what selects mode
   * B; omitting it keeps the exact M1 splice relay. Loading is the caller's
   * job (see the module doc comment). A `PolicyProvider` hot-reloads the
   * rules under the session; a plain `Policy` behaves exactly as before.
   */
  readonly policy?: Policy | PolicyProvider
  /**
   * Identity this server is known by in policy rules and quarantine.
   * Defaults to `auto:<sha256(command+args) prefix>`.
   */
  readonly serverName?: string
  /** Approvals queue root. Defaults to `<journal dir>/approvals`. */
  readonly approvalsBaseDir?: string
  /** Tool inventory store file. Defaults to `<journal dir>/tool-inventory.json`. */
  readonly inventoryStorePath?: string
  /** Agent scope (M3, set by `connect`; never by ad-hoc `wrap` — exactly M2). Mode B only. */
  readonly agentScope?: GateAgentScope
  /**
   * The line the operator reads on this run's stderr when a call is queued
   * for approval (0.2.3). Formatted by the CLI, which knows how mcpcut was
   * started; written here through the guarded diagnostics stream. Absent
   * means a held call stays silent, as before. Mode B only.
   */
  readonly approvalNotice?: (notice: PendingApprovalNotice) => string
  /**
   * Also ask the person at the client about a held call (P2), when the
   * policy's `approval.askClient` allows it. Decided by the CLI, which knows
   * the installation (no admins yet) and how mcpcut was started. Mode B only.
   */
  readonly askClient?: AskClientOptions
  /**
   * The one line written when the session ends (the wrapped server exited or
   * the client left), after the journal is flushed: it names the session and
   * how to read it. Formatted by the CLI; absent means silence, as before.
   */
  readonly sessionEndNotice?: (sessionId: string) => string
  /**
   * Forces fail-closed journaling on regardless of `policy.journal.failClosed`
   * (the `--fail-closed` flag). Never forces it *off*: a policy that asks for
   * fail-closed always gets it.
   */
  readonly failClosed?: boolean
  /**
   * @internal test-only seam for injecting a failing journal batch commit, so
   * fail-closed behavior can be exercised without an unwritable disk.
   */
  readonly journalCommitBatchImpl?: JournalSinkOptions['commitBatchImpl']
}
