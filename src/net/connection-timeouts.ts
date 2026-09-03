import type { Server } from 'node:http'

/**
 * The per-connection timeouts both HTTP fronts — the agent-facing `serve`
 * listener and the admin UI — set explicitly instead of inheriting Node's
 * defaults (security audit 2026-09-02, F3 / LOW-2). One module, so the two
 * fronts cannot drift apart in how the values are applied or read back; the
 * VALUES stay with each front's own constants, because their reasoning differs
 * (an MCP body vs. an admin form).
 */
export interface ConnectionTimeouts {
  readonly headersTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly keepAliveTimeoutMs: number
}

/**
 * Sets the three timers on a freshly created server. `headersTimeout` must
 * not exceed `requestTimeout`: Node checks the pair only when both arrive as
 * `createServer` options, not on property assignment, so the guard lives here
 * and fails at startup — a misordered pair would otherwise let a header-only
 * trickle outlive the whole-request budget.
 */
export function applyConnectionTimeouts(instance: Server, timeouts: ConnectionTimeouts): void {
  if (timeouts.headersTimeoutMs > timeouts.requestTimeoutMs) {
    throw new RangeError(
      `headersTimeout (${timeouts.headersTimeoutMs} ms) must not exceed requestTimeout (${timeouts.requestTimeoutMs} ms)`,
    )
  }
  instance.headersTimeout = timeouts.headersTimeoutMs
  instance.requestTimeout = timeouts.requestTimeoutMs
  instance.keepAliveTimeout = timeouts.keepAliveTimeoutMs
}

/** What the live server actually carries (tests read this back). */
export function readConnectionTimeouts(instance: Server): ConnectionTimeouts {
  return Object.freeze({
    headersTimeoutMs: instance.headersTimeout,
    requestTimeoutMs: instance.requestTimeout,
    keepAliveTimeoutMs: instance.keepAliveTimeout,
  })
}
