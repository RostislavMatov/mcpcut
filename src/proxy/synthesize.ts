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
 * one. The message is written to prompt a retry: once an operator approves
 * the pending request, the agent is expected to call the tool again.
 */
export function approvalTimeoutError(id: SynthesizableId, info: ApprovalTimeoutErrorInfo): Buffer {
  return synthesizeError(id, {
    code: ERROR_CODE_APPROVAL,
    message:
      `Call to tool "${info.toolName}" requires human approval and timed out waiting for one. ` +
      `An operator can approve it with \`mcp-journal approvals approve ${info.approvalId}\` — ` +
      'retry this call after they confirm.',
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

/** A `tools/call` to a new or changed tool still awaiting quarantine review. */
export function quarantinedError(id: SynthesizableId, info: QuarantinedErrorInfo): Buffer {
  return synthesizeError(id, {
    code: ERROR_CODE_QUARANTINED,
    message:
      `Tool "${info.toolName}" on server "${info.serverName}" is quarantined (new or changed) ` +
      'and cannot be called until reviewed. An operator can approve it with ' +
      `\`mcp-journal quarantine approve ${info.serverName} ${info.toolName}\`.`,
    data: { reason: 'quarantined', toolName: info.toolName, serverName: info.serverName },
  })
}
