import type { JsonRpcId } from '../protocol/classify.js'

/**
 * Synthesizes JSON-RPC 2.0 error responses that the proxy answers locally,
 * without ever reaching the downstream MCP server: policy denials, approval
 * timeouts/denials, and quarantined tools.
 *
 * Every message here is agent-facing UX, not just a status code: an agent
 * reading `error.message` should understand *why* the call didn't happen and
 * what — if anything — it or a human operator can do next. `error.data`
 * carries the same facts machine-readably, for callers that parse structure
 * instead of prose.
 *
 * Output is always a single JSON-RPC line plus a trailing `\n`, ready to
 * write straight to the client's stdin. `JSON.stringify` never emits a
 * literal newline (control characters, including `\n` inside `message`, are
 * escaped as `\uXXXX`/`\n` sequences), so single-line-ness holds by
 * construction — no message content can break framing.
 */

/** Reserved for policy decisions: a `tools/call` was blocked by an allow/deny rule. */
export const ERROR_CODE_POLICY_DENIED = -32001
/** Reserved for the human-approval workflow: required, timed out, or denied. */
export const ERROR_CODE_APPROVAL = -32002
/** Reserved for calls to a tool still awaiting quarantine review. */
export const ERROR_CODE_QUARANTINED = -32003

/**
 * A JSON-RPC id valid for a synthesized response. Deliberately excludes
 * `null`: a `tools/call` request with a `null` id has no return address a
 * reply could be routed to, so callers must drop such a gated call (and
 * journal the drop) instead of trying to synthesize a reply for it.
 */
export type SynthesizableId = Exclude<JsonRpcId, null>

export interface SynthesizedErrorInfo {
  readonly code: number
  readonly message: string
  readonly data?: Record<string, unknown>
}

/**
 * Builds a single-line JSON-RPC 2.0 error response with a trailing `\n`,
 * ready to write to a client's stdin.
 */
export function synthesizeError(id: SynthesizableId, info: SynthesizedErrorInfo): Buffer {
  const body = {
    jsonrpc: '2.0',
    id,
    error: {
      code: info.code,
      message: info.message,
      ...(info.data !== undefined ? { data: info.data } : {}),
    },
  }

  return Buffer.from(`${JSON.stringify(body)}\n`, 'utf8')
}

export interface DenialErrorInfo {
  readonly toolName: string
  readonly rule: string
}

/** A `tools/call` blocked by an allow/deny policy rule. */
export function denialError(id: SynthesizableId, info: DenialErrorInfo): Buffer {
  return synthesizeError(id, {
    code: ERROR_CODE_POLICY_DENIED,
    message:
      `Call to tool "${info.toolName}" was blocked by policy rule "${info.rule}". ` +
      'A human operator can change the policy to allow it.',
    data: { reason: 'policy_denied', toolName: info.toolName, rule: info.rule },
  })
}

export interface ApprovalTimeoutErrorInfo {
  readonly toolName: string
  readonly approvalId: string
}

/**
 * A `tools/call` that required human approval, and timed out waiting for
 * one. The message prompts a retry once a human operator approves the
 * pending request — but deliberately does not tell the agent *how* to make
 * that happen: the approve command belongs to the human, who already sees
 * the pending request in the admin UI and `approvals list`, not to the
 * blocked party reading this string. Handing the agent a ready-to-run
 * self-approval command through the one channel it reads and trusts by
 * default would make the human-in-the-loop guarantee rest on the agent's
 * unwillingness to run it, not on any mechanism.
 *
 * `approvalId` stays out of the prose for the same reason — pairing it with
 * free text an agent parses is what turns a fact into an instruction it can
 * act on — but it remains in `data.approvalId` for legitimate structured
 * correlation (e.g. tooling matching this refusal to a queue entry), which
 * the human-facing surfaces already have without needing it echoed back.
 */
export function approvalTimeoutError(id: SynthesizableId, info: ApprovalTimeoutErrorInfo): Buffer {
  return synthesizeError(id, {
    code: ERROR_CODE_APPROVAL,
    message:
      `Call to tool "${info.toolName}" requires human approval and timed out waiting for one. ` +
      'A human operator needs to approve the pending request before this call can proceed; ' +
      'retry once they do.',
    data: { reason: 'approval_timeout', toolName: info.toolName, approvalId: info.approvalId },
  })
}

export interface ApprovalDeniedErrorInfo {
  readonly toolName: string
}

/** A `tools/call` that required human approval, and was explicitly denied. */
export function approvalDeniedError(id: SynthesizableId, info: ApprovalDeniedErrorInfo): Buffer {
  return synthesizeError(id, {
    code: ERROR_CODE_APPROVAL,
    message: `Call to tool "${info.toolName}" was denied by a human operator during approval review.`,
    data: { reason: 'approval_denied', toolName: info.toolName },
  })
}

export interface QuarantinedErrorInfo {
  readonly toolName: string
  readonly serverName: string
}

/**
 * A `tools/call` to a new or changed tool still awaiting quarantine review.
 *
 * Same reasoning as {@link approvalTimeoutError}: the reviewer's approve
 * command is not included, since the only reader of this string is the
 * party the quarantine gates, not the operator who reviews it elsewhere.
 */
export function quarantinedError(id: SynthesizableId, info: QuarantinedErrorInfo): Buffer {
  return synthesizeError(id, {
    code: ERROR_CODE_QUARANTINED,
    message:
      `Tool "${info.toolName}" on server "${info.serverName}" is quarantined (new or changed) ` +
      'and cannot be called until a human operator reviews it.',
    data: { reason: 'quarantined', toolName: info.toolName, serverName: info.serverName },
  })
}
