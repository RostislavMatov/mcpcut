import type { AgentRecord } from '../agents/schema.js'
import { createRecordBuilder } from '../journal/record.js'
import { createJournalSink, type JournalSink, type JournalSinkOptions } from '../journal/sink.js'
import { createApprovalQueue } from '../policy/approvals/queue.js'
import { createApprovalWaiter } from '../policy/approvals/waiter.js'
import { createGrantRegistry } from '../policy/approvals/grants.js'
import { createInventory } from '../policy/inventory.js'
import type { PolicyProvider } from '../policy/reload.js'
import type { Policy } from '../policy/schema.js'
import type { ServerRecord } from '../registry/schema.js'
import type { AgentRecordReader } from '../session/agent-watch.js'
import { createSession, type SessionEndReason, type SessionHandle } from '../session/core.js'
import type {
  OpenedSession,
  OpenSessionRefusal,
  SessionContext,
} from '../transport/http/session.js'
import type { ServeWritable } from './serve-constants.js'
import { createMemoryPipe } from './serve-pipe.js'
import { openUpstream, type OpenUpstreamDeps } from './serve-upstream.js'

/**
 * Building ONE fully wired single-server session: journal sink and record
 * builder, inventory, approvals, grants, the upstream, and the memory pipe
 * that joins it to whoever is driving it.
 *
 * Extracted from `serve-runtime.ts` unchanged when the pool arrived (ADR-0015
 * phase 3): both serve modes need exactly this, and a pool's child session is
 * a per-server session in every respect — same gate, same policy, same
 * quarantine, same approvals, same decision records under the BARE tool name
 * (PE11). `serve-runtime.ts` keeps what is genuinely its own: the order in
 * which a per-server request is refused.
 *
 * What a pool needs on top is one field: the journal session id, so a
 * `kind:'pool'` record can bind the pool's session to this child's. The front
 * ignores it.
 *
 * Refusal bodies are codes only. Everything explanatory — which secret is
 * missing, why a spawn failed — goes to the plane's stderr, never into an HTTP
 * response: secret NAMES are operator information, not agent information (and
 * their VALUES appear nowhere at all).
 */

export interface ChildSessionDeps {
  readonly agents: AgentRecordReader
  /** Already validated, with any `--fail-closed` override applied; a provider hot-reloads it. */
  readonly policy: Policy | PolicyProvider
  readonly journalDir: string
  readonly approvalsBaseDir: string
  readonly inventoryStorePath: string
  readonly stderr: ServeWritable
  /** Environment/vault plumbing for upstreams (see `serve-upstream.ts`). */
  readonly upstream: Pick<
    OpenUpstreamDeps,
    'processEnv' | 'envAllowlist' | 'resolveRefs' | 'killEscalationMs' | 'httpClient'
  >
  /** Mints one journal session id per opened session. */
  readonly newSessionId: () => string
  readonly clock?: () => number
  readonly revocationPollIntervalMs?: number
  /** When true, a journal write failure ends the session it belongs to. */
  readonly failClosed: boolean
  /** @internal test-only seam mirroring `wrap`'s, for fail-closed tests. */
  readonly journalCommitBatchImpl?: JournalSinkOptions['commitBatchImpl']
}

/** The registry record and the agent a session was resolved to. */
export interface ChildSessionTarget {
  readonly record: ServerRecord
  readonly agent: AgentRecord
}

/** `OpenedSession` plus the journal session id a pool binds its records to. */
export interface OpenedChildSession extends OpenedSession {
  readonly sessionId: string
  /**
   * Why the session ended on its own terms, or `null` while it lives (or when
   * it was closed from outside). Set BEFORE the front source ends, so a pool
   * listening on that end reads the reason in the same synchronous chain.
   */
  readonly endReason: () => SessionEndReason | null
}

export type ChildSessionOpener = (
  ctx: SessionContext,
  target: ChildSessionTarget,
) => Promise<OpenedChildSession | OpenSessionRefusal>

/** One session's journal wiring, bound to a freshly minted session id. */
interface SessionJournalWiring {
  readonly sessionId: string
  readonly sink: JournalSink
  readonly writeStderrLine: (line: string) => void
  /** Tells this session's record builder which exact values went upstream. */
  readonly registerKnownSecrets: (values: readonly string[]) => void
  readonly deps: Parameters<typeof createSession>[0]['journal']
}

export function createChildSessionOpener(deps: ChildSessionDeps): ChildSessionOpener {
  function report(ctx: SessionContext, message: string): void {
    deps.stderr.write(`[serve] ${ctx.agentName}/${ctx.serverName}: ${message}\n`)
  }

  /** Journal sink + record builder for one session; `endSession` is late-bound. */
  function createJournalWiring(endSession: () => void): SessionJournalWiring {
    const sessionId = deps.newSessionId()
    const sink = createJournalSink(sessionId, {
      dir: deps.journalDir,
      ...(deps.journalCommitBatchImpl !== undefined
        ? { commitBatchImpl: deps.journalCommitBatchImpl }
        : {}),
      ...(deps.failClosed
        ? {
            onWriteError: () => {
              // "No audit record, no traffic": the session that lost its
              // record dies, while every other agent's session lives on —
              // the daemon shape of fail-closed.
              deps.stderr.write(`[serve] journal write failed in session ${sessionId}; ending it\n`)
              endSession()
            },
          }
        : {}),
    })
    const recordBuilder = createRecordBuilder(
      sessionId,
      deps.clock !== undefined ? { now: deps.clock } : {},
    )
    return {
      sessionId,
      sink,
      writeStderrLine: (line: string) => sink.write(recordBuilder.buildStderrRecord(line)),
      registerKnownSecrets: recordBuilder.registerKnownSecrets,
      deps: { recordBuilder, sink },
    }
  }

  /** Everything a live session needs beyond its transports. */
  function sessionDepsOf(
    ctx: SessionContext,
    target: ChildSessionTarget,
    journal: SessionJournalWiring,
  ): Omit<Parameters<typeof createSession>[0], 'client' | 'server' | 'onSessionEnd'> {
    const onError = (error: unknown): void => report(ctx, describeError(error))
    return {
      sessionId: journal.sessionId,
      serverName: target.record.name,
      policy: deps.policy,
      inventory: createInventory(target.record.name, {
        storePath: deps.inventoryStorePath,
        onError,
        ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
      }),
      approvals: {
        queue: createApprovalQueue({ baseDir: deps.approvalsBaseDir }),
        waiter: createApprovalWaiter(),
        baseDir: deps.approvalsBaseDir,
      },
      grants: createGrantRegistry(),
      journal: journal.deps,
      agent: { record: target.agent, store: deps.agents },
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
      ...(deps.revocationPollIntervalMs !== undefined
        ? { revocationPollIntervalMs: deps.revocationPollIntervalMs }
        : {}),
      onError,
    }
  }

  /** Opens the upstream and wires it to the caller through the memory pipe. */
  return async function openChildSession(
    ctx: SessionContext,
    target: ChildSessionTarget,
  ): Promise<OpenedChildSession | OpenSessionRefusal> {
    let handle: SessionHandle | null = null
    let endedWith: SessionEndReason | null = null
    const journal = createJournalWiring(() => {
      void handle?.close('closed')
    })

    const opened = await openUpstream(target.record, {
      ...deps.upstream,
      // The one place a decrypted vault value passes through on this path, so
      // the one place that can tell the journal what to redact. Registration
      // happens here rather than after `openUpstream` returns so that not even
      // the child's very first stderr line can outrun it.
      resolveRefs: collectKnownSecrets(deps.upstream.resolveRefs, journal.registerKnownSecrets),
      onServerStderr: journal.writeStderrLine,
      onError: (error: unknown) => report(ctx, describeError(error)),
    })
    if (opened.status === 'refused') {
      if (opened.detail !== undefined) {
        report(ctx, opened.detail)
      }
      await journal.sink.close()
      return { error: opened.error }
    }

    const pipe = createMemoryPipe()
    let closePromise: Promise<void> | null = null
    const closeAll = (): Promise<void> => {
      closePromise ??= (async () => {
        await handle?.close('closed')
        await opened.upstream.close()
        await journal.sink.close()
      })()
      return closePromise
    }

    try {
      handle = createSession({
        ...sessionDepsOf(ctx, target, journal),
        client: { source: pipe.session.source, sink: pipe.session.sink },
        server: { source: opened.upstream.source, sink: opened.upstream.sink },
        onSessionEnd: (reason) => {
          // The session died on its own terms (revocation, upstream end):
          // tell whoever is driving it, whose teardown then calls `close()` —
          // which is what reaps the child process and closes the journal.
          // Recorded first: `endFrontSource` runs the pool's `onEnd` in this
          // very chain, and that is where the reason is read (DR1).
          endedWith = reason
          report(ctx, `session ${journal.sessionId} ended (${reason})`)
          pipe.endFrontSource()
        },
      })
    } catch (error: unknown) {
      // Never leave a spawned child (or an open HTTP client) behind because
      // the session assembly itself failed.
      report(ctx, describeError(error))
      await closeAll()
      throw error
    }

    return {
      sessionId: journal.sessionId,
      sink: pipe.front.sink,
      source: pipe.front.source,
      close: closeAll,
      endReason: () => endedWith,
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Wraps a vault resolver so every successfully resolved env/header value is
 * registered as a known secret for this session's journal. Registry literals
 * are included on purpose: an operator who declared a value inline did not
 * thereby declare it public, and hiding a non-secret costs nothing
 * (`redact/known-secrets.ts` drops anything under 8 characters).
 */
function collectKnownSecrets(
  resolveRefs: OpenUpstreamDeps['resolveRefs'],
  register: (values: readonly string[]) => void,
): OpenUpstreamDeps['resolveRefs'] {
  return async (record) => {
    const result = await resolveRefs(record)
    if (result.status === 'resolved') {
      register(Object.values(result.values))
    }
    return result
  }
}
