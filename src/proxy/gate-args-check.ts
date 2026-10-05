import type { ParsedToolCall } from '../protocol/mcp.js'

/**
 * A tighten-only step on the call gate (ADR-0020 §2). It looks at the
 * arguments of one `tools/call` — which `decide()` never does, it is pure and
 * sees only the tool name — and either finds nothing wrong (`null`) or
 * refuses with a stable `rule` string that lands in the decision record and a
 * one-line `reason`. The gate turns a refusal into `deny`; it never lets a
 * check turn a deny or a require-approval into an allow.
 *
 * Injected, not imported: the gate knows nothing of any one server's
 * arguments, and only a session for a server that has such a check passes one.
 */
export interface ArgsRefusal {
  readonly rule: string
  readonly reason: string
  /** What the client is told instead of the generic policy denial: the same words the server would answer with. */
  readonly clientMessage: string
}

export type ArgsCheck = (call: ParsedToolCall) => Promise<ArgsRefusal | null>
