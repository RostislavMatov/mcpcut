import { CONTENT_SECURITY_POLICY, STRICT_TRANSPORT_SECURITY } from './constants.js'

/**
 * The security headers the UI attaches to EVERY response — pages, assets,
 * errors, redirects and the SSE stream alike (ADR-0004 threat model). A pure
 * function returning a fresh object each call so callers can spread it and
 * override nothing by accident.
 *
 * - `Content-Security-Policy`: the single defense against XSS through
 *   MCP-server-controlled content (tool descriptions, call arguments, journal
 *   payloads). `default-src 'none'` plus a per-directive `'self'` allowlist;
 *   no inline scripts, `frame-ancestors 'none'` (clickjacking), `base-uri
 *   'none'`.
 * - `X-Content-Type-Options: nosniff`: a JSON/asset response is never
 *   re-interpreted as HTML by content sniffing.
 * - `Referrer-Policy: same-origin`: a session URL never leaks to any OTHER
 *   origin, while same-origin requests keep their referrer. It must NOT be
 *   tightened to `no-referrer`: per the Fetch spec a document under
 *   `no-referrer` serializes the `Origin` header of its form POSTs as `null`,
 *   which our own Origin screening rejects (opaque origins are a CSRF
 *   surface) — locking every Chromium browser out of `/login`. Found by the
 *   manual smoke 2026-08-11 (docs/smoke-m4.md); pinned by the hardening test.
 * - `X-Frame-Options: DENY`: belt-and-braces clickjacking cover for the same
 *   surface `frame-ancestors 'none'` protects, for older agents.
 * - `Strict-Transport-Security`: ONLY with `--behind-tls`. Over plain loopback
 *   HTTP the header is inert, and on a name shared with other services it would
 *   pin that name to HTTPS for a year from a listener that does not serve it.
 */
export function securityHeaders(opts: { behindTls: boolean } = { behindTls: false }): Record<string, string> {
  return {
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': 'DENY',
    ...(opts.behindTls ? { 'strict-transport-security': STRICT_TRANSPORT_SECURITY } : {}),
  }
}
