import { CONTENT_SECURITY_POLICY } from './constants.js'

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
 * - `Referrer-Policy: no-referrer`: a session URL never leaks to any other
 *   origin (there are none, but defense in depth).
 * - `X-Frame-Options: DENY`: belt-and-braces clickjacking cover for the same
 *   surface `frame-ancestors 'none'` protects, for older agents.
 */
export function securityHeaders(): Record<string, string> {
  return {
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  }
}
