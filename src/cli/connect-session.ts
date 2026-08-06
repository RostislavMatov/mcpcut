import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import { createRecordBuilder } from '../journal/record.js'
import { createJournalSink, type JournalSinkOptions } from '../journal/sink.js'
import { createGrantRegistry } from '../policy/approvals/grants.js'
import { createApprovalQueue } from '../policy/approvals/queue.js'
import { createApprovalWaiter } from '../policy/approvals/waiter.js'
import { createInventory, INVENTORY_FILE_NAME } from '../policy/inventory.js'
import type { Policy } from '../policy/schema.js'
import {
  createSession,
  type SessionAgent,
  type SessionEndpoints,
  type SessionHandle,
} from '../session/core.js'
import { DIAGNOSTIC_PREFIX } from './connect-constants.js'

/**
 * Assembles one `connect` session's non-transport half — journal, tool
 * inventory, approvals, grant registry — and hands it to `session/core.ts`
 * together with the endpoints the caller built.
 *
 * `session/core.ts` owns the session itself (gate wiring, agent-revocation
 * watch, teardown order); this module owns only what has to be constructed
 * around it, and it deliberately mirrors `proxy/wire-policy.ts`'s choices so
 * a `connect` session and a `wrap` session write the same things to the same
 * places: approvals and the tool inventory default UNDER the journal
 * directory in use, not under `JOURNAL_DIR` unconditionally.
 *
 * Fail-closed journaling ("no audit record, no traffic") is wired here rather
 * than through `proxy/journal-failure.ts`: that controller shuts down a
 * wrapped CHILD and a Frame-level relay, neither of which exists on the HTTP
 * path. The rule is the same — the first dropped record ends the session —
 * and the caller reports it with `wrap.ts`'s `EXIT_CODE_JOURNAL_FAILURE`, so
 * a supervisor sees one code for the condition regardless of the command.
 */

/** The subdirectory `policy/approvals/queue.ts` uses under the journal dir. */
const APPROVALS_SUBDIR = 'approvals'

export interface StartConnectSessionArgs {
  readonly sessionId: string
  /** Registry name of the proxied server — never `auto:<hash>` on this path. */
  readonly serverName: string
  readonly agent: SessionAgent
  readonly client: SessionEndpoints
  readonly server: SessionEndpoints
  /** Pre-loaded, already-validated policy (loading is the caller's job). */
  readonly policy: Policy
  /** `--fail-closed`; only ever turns fail-closed ON, never off. */
  readonly failClosed: boolean
  /**
   * Exact values handed to the upstream (`connect-upstream.ts`'s resolved env
   * or headers, literals included). Registered on this session's record
   * builder so the journal redacts material the plane injected itself — see
   * `redact/known-secrets.ts`.
   */
  readonly knownSecrets?: readonly string[]
  readonly journalDir?: string
  readonly approvalsBaseDir?: string
  readonly inventoryStorePath?: string
  /** Injectable clock (ms since epoch) for deterministic tests. */
  readonly now?: () => number
  /** Revocation poll interval; defaults to the ≤5 s session constant. */
  readonly revocationPollIntervalMs?: number
  /** One complete, newline-terminated diagnostic line. Always stderr-bound. */
  readonly onDiagnostic: (line: string) => void
  /** @internal test-only seam for exercising fail-closed without an unwritable disk. */
  readonly journalAppendFileImpl?: JournalSinkOptions['appendFileImpl']
}

export interface ConnectSessionHandle {
  readonly session: SessionHandle
  /** Journals one raw stderr line from the wrapped server. Never throws. */
  tapStderrLine(line: string): void
  /** True once a record was dropped while journaling was fail-closed. */
  hasJournalFailed(): boolean
  /** Flushes and closes the journal; call after the upstream has finished. */
  closeJournal(): Promise<void>
}

/**
 * Applies the `--fail-closed` override to the policy the gate reads, so there
 * is exactly one source of truth for the flag inside the session. Returns the
 * original object when nothing changes.
 */
function effectivePolicyOf(policy: Policy, failClosed: boolean): Policy {
  if (policy.journal.failClosed === failClosed) {
    return policy
  }
  return { ...policy, journal: { ...policy.journal, failClosed } }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface JournalFailureGuard {
  /** The sink's `onWriteError`: the first dropped record ends the session. */
  report(error: unknown): void
  /** Supplies the session to end — the sink exists before it does. */
  arm(session: SessionHandle): void
  hasFailed(): boolean
}

/**
 * "No audit record, no traffic" for one connect session. Separate from the
 * sink's construction because the thing it has to shut down (the session)
 * cannot exist until the sink does; a failure reported before `arm()` is
 * honored as soon as arming happens — the same shape as
 * `proxy/journal-failure.ts`, minus its child/relay targets.
 */
function createJournalFailureGuard(onDiagnostic: (line: string) => void): JournalFailureGuard {
  let hasFailed = false
  let session: SessionHandle | null = null

  return {
    hasFailed: () => hasFailed,
    arm: (next: SessionHandle) => {
      session = next
      if (hasFailed) {
        void session.close('closed')
      }
    },
    report: (error: unknown) => {
      if (hasFailed) return
      hasFailed = true
      onDiagnostic(
        `${DIAGNOSTIC_PREFIX} journal write failed and journaling is fail-closed; ` +
          `ending the session: ${describe(error)}\n`,
      )
      void session?.close('closed')
    },
  }
}

export function startConnectSession(args: StartConnectSessionArgs): ConnectSessionHandle {
  const journalDir = args.journalDir ?? JOURNAL_DIR
  const isFailClosed = args.failClosed || args.policy.journal.failClosed
  const approvalsBaseDir = args.approvalsBaseDir ?? join(journalDir, APPROVALS_SUBDIR)
  const inventoryStorePath = args.inventoryStorePath ?? join(journalDir, INVENTORY_FILE_NAME)

  const onError = (error: unknown): void => {
    args.onDiagnostic(`${DIAGNOSTIC_PREFIX} ${describe(error)}\n`)
  }
  const failure = createJournalFailureGuard(args.onDiagnostic)

  const sink = createJournalSink(args.sessionId, {
    dir: journalDir,
    ...(isFailClosed ? { onWriteError: failure.report } : {}),
    ...(args.journalAppendFileImpl !== undefined
      ? { appendFileImpl: args.journalAppendFileImpl }
      : {}),
  })
  const recordBuilder = createRecordBuilder(
    args.sessionId,
    args.now !== undefined ? { now: args.now } : {},
  )

  const session = createSession({
    sessionId: args.sessionId,
    serverName: args.serverName,
    client: args.client,
    server: args.server,
    policy: effectivePolicyOf(args.policy, isFailClosed),
    inventory: createInventory(args.serverName, { storePath: inventoryStorePath, onError }),
    approvals: {
      queue: createApprovalQueue({ baseDir: approvalsBaseDir }),
      waiter: createApprovalWaiter(),
      baseDir: approvalsBaseDir,
    },
    grants: createGrantRegistry(),
    journal: { recordBuilder, sink },
    ...(args.knownSecrets !== undefined ? { knownSecrets: args.knownSecrets } : {}),
    agent: args.agent,
    ...(args.now !== undefined ? { clock: args.now } : {}),
    ...(args.revocationPollIntervalMs !== undefined
      ? { revocationPollIntervalMs: args.revocationPollIntervalMs }
      : {}),
    onError,
  })

  failure.arm(session)

  return {
    session,
    // Deliberately not `relay.ts`'s `tapStderr`: that one reports failures on
    // a `Writable` with a `[wrap]` prefix, while every diagnostic on this path
    // goes through `onDiagnostic`. The journaling itself is the same call.
    tapStderrLine: (line: string) => {
      try {
        sink.write(recordBuilder.buildStderrRecord(line))
      } catch (error: unknown) {
        onError(error)
      }
    },
    hasJournalFailed: failure.hasFailed,
    closeJournal: async () => {
      await sink.close()
      const dropped = sink.droppedRecordCount()
      if (dropped > 0) {
        args.onDiagnostic(`${DIAGNOSTIC_PREFIX} journal records dropped this session: ${dropped}\n`)
      }
    },
  }
}
