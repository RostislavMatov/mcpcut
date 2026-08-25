import type { AgentRecord } from '../agents/schema.js'
import { createRecordBuilder } from '../journal/record.js'
import { createJournalSink, type JournalSink, type JournalSinkOptions } from '../journal/sink.js'
import { createApprovalQueue } from '../policy/approvals/queue.js'
import { createApprovalWaiter } from '../policy/approvals/waiter.js'
import { createGrantRegistry } from '../policy/approvals/grants.js'
import { createInventory } from '../policy/inventory.js'
import type { PolicyProvider } from '../policy/reload.js'
import type { Policy } from '../policy/schema.js'
import type { RegistryStore } from '../registry/store.js'
import type { ServerRecord } from '../registry/schema.js'
import { isRevokedFor, type AgentRecordReader } from '../session/agent-watch.js'
import { createSession, type SessionHandle } from '../session/core.js'
import type {
  OpenSession,
  OpenedSession,
  OpenSessionRefusal,
  SessionContext,
} from '../transport/http/session.js'
import {
  REFUSAL_MODEL_UNDETECTED,
  REFUSAL_NO_GRANT,
  REFUSAL_UNKNOWN_SERVER,
  type ServeWritable,
} from './serve-constants.js'
import type { ModelHandoff } from './serve-hooks.js'
import { createMemoryPipe } from './serve-pipe.js'
import { checkModelCompatibility, openUpstream, type OpenUpstreamDeps } from './serve-upstream.js'

/**
 * The `openSession` factory `serve` injects into the HTTP front (M3 Task 13)
 * — the heart of the command: one authenticated (agent, server) request pair
 * becomes one fully wired `session/core.ts` session.
 *
 * Refusal order is a security decision, not an implementation accident:
 *
 *   1. downstream model known?  (fail closed — see `serve-hooks.ts`)
 *   2. agent re-read from the store, still granted THIS server? → `no-grant`
 *   3. registry record exists?                                  → `unknown-server`
 *   4. session models compatible (ADR-0002)?                    → mismatch text
 *   5. upstream opens (vault refs resolve, child spawns)?       → vault codes
 *
 * The grant check precedes the registry lookup on purpose: an agent without
 * a grant learns nothing about which servers the plane has registered — it
 * gets the same `no-grant` whether the name exists or not. Step 2 also
 * re-reads the agent instead of trusting the front's authentication result,
 * so a revocation between the token check and the session opening cannot
 * produce a live session.
 *
 * Refusal bodies are codes only. Everything explanatory — which secret is
 * missing, why a spawn failed — goes to the plane's stderr, never into an
 * HTTP response: secret NAMES are operator information, not agent
 * information (and their VALUES appear nowhere at all).
 *
 * Journal shape: one journal session id per opened session, exactly like
 * `wrap`. A stateless downstream request is its own session by definition
 * (the front opens and closes one per POST), so it gets its own journal
 * session — the audit record of a stateless call is self-contained.
 */

export interface ServeRuntimeDeps {
  readonly registry: Pick<RegistryStore, 'getServer'>
  readonly agents: AgentRecordReader
  /** Downstream model of the request currently being opened (see serve-hooks). */
  readonly handoff: ModelHandoff
  /** Already validated, with any `--fail-closed` override applied; a provider hot-reloads it. */
  readonly policy: Policy | PolicyProvider
  readonly journalDir: string
  readonly approvalsBaseDir: string
  readonly inventoryStorePath: string
  readonly stderr: ServeWritable
  /** Environment/vault plumbing for upstreams (see `serve-upstream.ts`). */
  readonly upstream: Pick<OpenUpstreamDeps, 'processEnv' | 'envAllowlist' | 'resolveRefs' | 'killEscalationMs'>
  /** Mints one journal session id per opened session. */
  readonly newSessionId: () => string
  readonly clock?: () => number
  readonly revocationPollIntervalMs?: number
  /** When true, a journal write failure ends the session it belongs to. */
  readonly failClosed: boolean
  /** @internal test-only seam mirroring `wrap`'s, for fail-closed tests. */
  readonly journalCommitBatchImpl?: JournalSinkOptions['commitBatchImpl']
}

/** One session's journal wiring, bound to a freshly minted session id. */
interface SessionJournalWiring {
  readonly sessionId: string
  readonly sink: JournalSink
  readonly writeStderrLine: (line: string) => void
  /** Tells this session's record builder which exact values went upstream. */
  readonly registerKnownSecrets: (values: readonly string[]) => void
  readonly deps: Parameters<typeof createSession>[0]['journal']
}

export function createServeSessionFactory(deps: ServeRuntimeDeps): OpenSession {
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

  async function resolveTarget(
    ctx: SessionContext,
  ): Promise<{ record: ServerRecord; agent: AgentRecord } | OpenSessionRefusal> {
    const model = deps.handoff.take()
    if (model === null) {
      report(ctx, 'the downstream session model could not be determined; refusing')
      return { error: REFUSAL_MODEL_UNDETECTED }
    }
    const agent = await deps.agents.getAgent(ctx.agentName)
    if (agent === undefined || isRevokedFor(agent, ctx.serverName)) {
      return { error: REFUSAL_NO_GRANT }
    }
    const record = await deps.registry.getServer(ctx.serverName)
    if (record === undefined) {
      return { error: REFUSAL_UNKNOWN_SERVER }
    }
    const mismatch = checkModelCompatibility(model, record)
    if (mismatch !== null) {
      report(ctx, mismatch)
      return { error: mismatch }
    }
    return { record, agent }
  }

  /** Everything a live session needs beyond its transports. */
  function sessionDepsOf(
    ctx: SessionContext,
    target: { record: ServerRecord; agent: AgentRecord },
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

  /** Opens the upstream and wires it to the front through the memory pipe. */
  async function startSession(
    ctx: SessionContext,
    target: { record: ServerRecord; agent: AgentRecord },
  ): Promise<OpenedSession | OpenSessionRefusal> {
    let handle: SessionHandle | null = null
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
          // tell the front, whose teardown then calls `close()` — which is
          // what reaps the child process and closes the journal.
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

    return { sink: pipe.front.sink, source: pipe.front.source, close: closeAll }
  }

  const openSession: OpenSession = async (ctx) => {
    const target = await resolveTarget(ctx)
    return 'error' in target ? target : startSession(ctx, target)
  }

  return openSession
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
