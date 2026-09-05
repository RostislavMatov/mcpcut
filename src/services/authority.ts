/**
 * `host:port` for a host that may or may not already be bracketed.
 *
 * An operator writes an IPv6 bind address either way — `::1` in one config,
 * `[::1]` in the next — and both spellings are legitimate. Bracketing blindly
 * turns the second into `[[::1]]:8091`, which is not a URL and not an address
 * anything can be dialled on, so the probe silently fails and the status table
 * silently lies. One function so the probe and the status table cannot drift
 * apart on it (review SEC-L3).
 *
 * Import-free on purpose: it is a string rule, shared by a module that opens
 * sockets and a module that must not.
 */

/** A host already written in URL form: `[` … `]` around a bare IPv6 literal. */
const BRACKETED_HOST_PATTERN = /^\[(.+)\]$/

/** The address itself, with any surrounding brackets taken off. */
export function unbracketHost(host: string): string {
  return BRACKETED_HOST_PATTERN.exec(host)?.[1] ?? host
}

/**
 * `host:port`, bracketing a bare IPv6 literal exactly once. A colon in the
 * host is what makes brackets necessary: without them a URL parser reads the
 * address's own colons as the port separator.
 */
export function hostAuthority(host: string, port: number): string {
  const address = unbracketHost(host)
  return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`
}
