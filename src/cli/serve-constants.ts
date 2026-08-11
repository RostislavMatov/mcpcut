/**
 * Constants for `mcp-journal serve` (M3 Task 13): CLI defaults, the session
 * factory's refusal codes, and the stateless header-mismatch error body.
 *
 * Per-area constants rule (`src/policy/constants.ts` precedent): these are
 * serve's own and live with serve, not in `src/config.ts`.
 *
 * The JSON-RPC error code below is spec semantics (SEP-2243). That is fine
 * HERE: the CLI layer is part of the semantic side of the plane — the
 * transport (`src/transport/http/*`) receives it only as an opaque injected
 * hook result and never imports this module.
 */

/**
 * Minimal writable-stream shape `serve` needs, declared here (rather than
 * imported from `cli.ts`) so no serve module depends on the dispatcher —
 * the same precedent as `cli/wrap-cmd.ts`.
 */
export interface ServeWritable {
  write(chunk: string): unknown
}

export interface ServeCliIo {
  readonly stdout: ServeWritable
  readonly stderr: ServeWritable
}

/** Default TCP port of the HTTP front. */
export const DEFAULT_SERVE_PORT = 8090

/**
 * Default bind address. Localhost by default is a security decision, not a
 * convenience one: agent Bearer tokens travel in clear text, so exposing the
 * front to a network requires the explicit `--host` flag (which makes the
 * transport layer print its own warning — `transport/http/server.ts`).
 */
export const DEFAULT_SERVE_HOST = '127.0.0.1'

/** Highest legal TCP port; `0` means "any free port" and is allowed. */
export const MAX_TCP_PORT = 65_535

export const SERVE_USAGE = `Usage:
  mcp-journal serve [--port ${DEFAULT_SERVE_PORT}] [--host ${DEFAULT_SERVE_HOST}] [--policy <path>] [--fail-closed]
                    [--allowed-origin <origin>]... [--allowed-host <host[:port]>]...
                                         Run the control plane's HTTP front for HTTP agents
`

/**
 * Session-factory refusal codes (`OpenSessionRefusal.error`). The HTTP front
 * maps `'unknown-server'` to 404 and everything else to a 400 whose body is
 * `{"error":"<code>"}` — so these strings ARE the response bodies agents see.
 * They deliberately carry no secret names, no registry contents and no
 * details beyond what the agent already sent in its own request; details go
 * to the plane's stderr only (see `serve-runtime.ts`).
 */
export const REFUSAL_NO_GRANT = 'no-grant'
export const REFUSAL_UNKNOWN_SERVER = 'unknown-server'
export const REFUSAL_MISSING_SECRETS = 'missing-secrets'
export const REFUSAL_INVALID_VAULT_REFS = 'invalid-vault-refs'
export const REFUSAL_VAULT_ERROR = 'vault-error'

/**
 * Refusal used if the session factory is ever invoked without a preceding
 * `detectInitialize` call on the same synchronous chain (see the
 * downstream-model handoff contract in `serve-runtime.ts`). Fail closed:
 * an unknown downstream model must never silently pick one.
 */
export const REFUSAL_MODEL_UNDETECTED = 'session-model-undetected'

/** SEP-2243 `HeaderMismatch`: stateless header↔body validation failed. */
export const JSONRPC_ERROR_HEADER_MISMATCH = -32020

/** Where the "no translation between session models" decision is recorded. */
export const ADR_0002_REFERENCE = 'docs/adr/0002-http-dual-version.md'

/**
 * The 400 body for a stateless request whose `Mcp-Method`/`Mcp-Name` header
 * does not mirror its body (or is missing/spurious — the spec matrix §2.3
 * treats absence as a MUST-level failure too). JSON-RPC error without an id,
 * per the matrix's error-body convention for pre-dispatch refusals.
 */
export function headerMismatchBody(headerName: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: JSONRPC_ERROR_HEADER_MISMATCH,
        message: `HeaderMismatch: ${headerName} header does not mirror the request body`,
      },
    }),
    'utf8',
  )
}

/** Downstream session model of one HTTP request, derived from its traffic (ADR-0002 §2). */
export type DownstreamModel = 'sessionful' | 'stateless'

/**
 * The refusal text for a downstream/upstream session-model mismatch. The
 * server name is safe to echo: the agent addressed it in its own URL.
 */
export function protocolMismatchRefusal(
  downstream: DownstreamModel,
  serverName: string,
  upstreamDescription: string,
): string {
  return (
    `protocol-mismatch: the agent opened a ${downstream} MCP session but server ` +
    `"${serverName}" is ${upstreamDescription}; the control plane does not translate ` +
    `between session models — see ${ADR_0002_REFERENCE}`
  )
}
