import type { AgentRecord } from '../agents/schema.js'
import type { RegistryStore } from '../registry/store.js'
import type { ServerRecord } from '../registry/schema.js'
import { isRevokedFor } from '../session/agent-watch.js'
import type {
  OpenSession,
  OpenSessionRefusal,
  SessionContext,
} from '../transport/http/session.js'
import {
  REFUSAL_MODEL_UNDETECTED,
  REFUSAL_NO_GRANT,
  REFUSAL_UNKNOWN_SERVER,
} from './serve-constants.js'
import { createChildSessionOpener, type ChildSessionDeps } from './serve-child.js'
import type { ModelHandoff } from './serve-hooks.js'
import { checkModelCompatibility } from './serve-upstream.js'

/**
 * The `openSession` factory `serve` injects into the HTTP front for a
 * PER-SERVER address (M3 Task 13): one authenticated (agent, server) request
 * pair becomes one fully wired `session/core.ts` session.
 *
 * Assembling that session moved to `serve-child.ts` when the pool arrived
 * (ADR-0015 phase 3), because a pool's child is the same thing. What stays
 * here is what is genuinely this address's own: the ORDER in which a request
 * is refused, which is a security decision rather than an implementation
 * accident:
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
 * Journal shape: one journal session id per opened session, exactly like
 * `wrap`. A stateless downstream request is its own session by definition
 * (the front opens and closes one per POST), so it gets its own journal
 * session — the audit record of a stateless call is self-contained.
 */

export interface ServeRuntimeDeps extends ChildSessionDeps {
  readonly registry: Pick<RegistryStore, 'getServer'>
  /** Downstream model of the request currently being opened (see serve-hooks). */
  readonly handoff: ModelHandoff
}

export function createServeSessionFactory(deps: ServeRuntimeDeps): OpenSession {
  const openChildSession = createChildSessionOpener(deps)

  function report(ctx: SessionContext, message: string): void {
    deps.stderr.write(`[serve] ${ctx.agentName}/${ctx.serverName}: ${message}\n`)
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

  const openSession: OpenSession = async (ctx) => {
    const target = await resolveTarget(ctx)
    return 'error' in target ? target : openChildSession(ctx, target)
  }

  return openSession
}
