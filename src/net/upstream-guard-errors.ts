import type { AddressRefusal } from './address-class.js'

/**
 * The one error of the tenant-mode SSRF guard (`./upstream-guard.ts`).
 *
 * Standalone on purpose: `src/net/**` may import only the platform
 * (`tests/architecture/imports.test.ts`), so this cannot extend the HTTP
 * client's `UpstreamConnectionError`. The client (`startRequest` in
 * `transport/http/client-wire.ts`) passes this error through UNWRAPPED —
 * wrapping would reduce the reason the operator must read to its code — and
 * the probe reports it as `error` with this message. The stable `code` stays
 * for anything that classifies errors by code.
 *
 * Error hygiene (ADR-0017 T4): the message names the host as written in the
 * registry record and the category of address — never the address a name
 * resolved to (that would map the hosting network's internal DNS for the
 * tenant), and never a path or query (they may carry tokens).
 */

/** Why the guard refused: the URL scheme, or the kind of address. */
export type UpstreamRefusal = AddressRefusal | 'scheme'

/** Where the refused address came from: the URL itself, or a DNS answer. */
export type AddressSource = 'literal' | 'resolved'

export const UPSTREAM_ADDRESS_REFUSED_CODE = 'ERR_UPSTREAM_ADDRESS_REFUSED'

const TENANT_SCOPE = 'this install reaches only public https servers (tenant mode)'
const SCHEME_SCOPE = 'this install reaches only https servers (tenant mode)'

export class UpstreamAddressRefusedError extends Error {
  readonly code = UPSTREAM_ADDRESS_REFUSED_CODE
  readonly host: string
  readonly reason: UpstreamRefusal

  constructor(host: string, reason: UpstreamRefusal, source: AddressSource = 'resolved') {
    super(`refused to connect to ${host}: ${explain(reason, source)}`)
    this.name = 'UpstreamAddressRefusedError'
    this.host = host
    this.reason = reason
  }
}

function explain(reason: UpstreamRefusal, source: AddressSource): string {
  if (reason === 'scheme') return SCHEME_SCOPE
  const verb = source === 'literal' ? 'it is' : 'it resolves to'
  return `${verb} ${articleFor(reason)} ${reason} address; ${TENANT_SCOPE}`
}

function articleFor(word: string): 'a' | 'an' {
  return /^[aeiou]/.test(word) ? 'an' : 'a'
}
