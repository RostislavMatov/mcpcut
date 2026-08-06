import { extractPerMessageHeaders } from '../protocol/mcp.js'
import type { HttpUpstreamProtocol } from '../transport/http/client.js'

/**
 * Who gets the stateless per-message header mirror (`Mcp-Method`/`Mcp-Name`,
 * SEP-2243) on an HTTP upstream — the single answer shared by `connect`
 * (`cli/connect-upstream.ts`) and `serve` (`cli/serve-upstream.ts`).
 *
 * The two commands used to disagree: `connect` sent the headers only for a
 * record pinned to `'stateless'`, `serve` sent them for everything except a
 * pinned `'sessionful'`. `'auto'` is the registry's DEFAULT, so a connect
 * session against a stateless server answered `-32020 HeaderMismatch` on
 * every single call.
 *
 * The asymmetry decides it: the headers are REQUIRED by the 2026-07-28
 * revision (spec matrix § per-message headers) and merely *unknown* to the
 * older sessionful revisions, which ignore unknown request headers. Sending
 * them where they are not needed costs nothing; omitting them where they are
 * required is fatal. So they are sent for `'auto'` and `'stateless'`, and
 * withheld only for an operator's explicit `'sessionful'` pin.
 *
 * This module lives under `src/session/` and not under `src/transport/`
 * on purpose: it imports `protocol/mcp.ts`, and the layering invariant
 * (CLAUDE.md, `tests/architecture/imports.test.ts`) forbids any transport
 * module from knowing MCP semantics. The transport keeps receiving the hook
 * injected, exactly as before.
 */

/** The HTTP client's `perMessageHeaders` hook: body bytes -> header map. */
export type PerMessageHeadersHook = (bytes: Buffer) => Record<string, string>

/**
 * The hook an upstream with this session model needs, or `undefined` when it
 * needs none (a pinned `'sessionful'` record — those revisions predate
 * SEP-2243).
 */
export function perMessageHeadersFor(
  protocol: HttpUpstreamProtocol,
): PerMessageHeadersHook | undefined {
  return protocol === 'sessionful' ? undefined : extractPerMessageHeaders
}

/**
 * `perMessageHeadersFor` shaped as the client's options object, so a call
 * site stays one expression. The key is omitted rather than set to
 * `undefined`: `exactOptionalPropertyTypes` treats those as different.
 */
export function perMessageHeadersOptionOf(
  protocol: HttpUpstreamProtocol,
): { readonly perMessageHeaders?: PerMessageHeadersHook } {
  const hook = perMessageHeadersFor(protocol)
  return hook === undefined ? {} : { perMessageHeaders: hook }
}
