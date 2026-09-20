import { formOf, type FieldSpec, type Form, type FormValues } from './form.js'
import { parseRemoteUrl, type RemoteUrl } from './remote/url.js'

/**
 * The welcome screen's "connect" form (2026-09-19): three fields, and the one
 * rule that turns them into the address `parseRemoteUrl` already knows how to
 * refuse.
 *
 * Pure and terminal-free, like every other field declaration in the console
 * (`wizard-fields.ts`, `update-first-owner.ts`): the candidate URL is built
 * from the form's values here and handed to the SAME validator `--remote`
 * itself is refused by (`remote/url.ts`), so a typo on this screen reads the
 * same as a typo on the command line — one validator, one refusal wording.
 * This module never touches the network; `connect-probe` (`runtime-effects.ts`)
 * is what actually dials the address this file only builds and checks the
 * shape of.
 */

export const CONNECT_HOST_FIELD = 'host'
export const CONNECT_PORT_FIELD = 'port'
export const CONNECT_PROTOCOL_FIELD = 'protocol'

const PROTOCOL_HTTPS = 'https'
const PROTOCOL_HTTP = 'http'

/** The two protocols the `Protocol` field offers, https first (the safer default). */
export const CONNECT_PROTOCOLS: readonly string[] = [PROTOCOL_HTTPS, PROTOCOL_HTTP]

/** A value that already names its own scheme: `Host` was pasted as a whole URL. */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i

export const CONNECT_FIELDS: readonly FieldSpec[] = [
  {
    name: CONNECT_HOST_FIELD,
    label: 'Host',
    kind: 'text',
    required: true,
    hint: 'name or address, or a whole https://host[:port] URL',
  },
  {
    name: CONNECT_PORT_FIELD,
    label: 'Port',
    kind: 'text',
    hint: '1..65535; leave empty when Host is a whole URL',
  },
  { name: CONNECT_PROTOCOL_FIELD, label: 'Protocol', kind: 'choice', options: CONNECT_PROTOCOLS },
]

/** The address the form's current values would dial, or which field to blame and why. */
export type ConnectResult =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false
      /** Absent when the refusal is `parseRemoteUrl`'s own — it names no one field. */
      readonly field?: typeof CONNECT_HOST_FIELD | typeof CONNECT_PORT_FIELD
      readonly message: string
    }

const REQUIRED_MESSAGE = 'required'
const PORT_RANGE_MESSAGE = 'expected 1..65535'
const MIN_PORT = 1
const MAX_PORT = 65535

function isWholeUrl(host: string): boolean {
  return SCHEME_PATTERN.test(host)
}

function isValidPort(port: string): boolean {
  return /^\d{1,5}$/.test(port) && Number(port) >= MIN_PORT && Number(port) <= MAX_PORT
}

/**
 * The URL the form's values would dial, before `parseRemoteUrl` ever sees it.
 * A whole URL pasted into `Host` wins outright — its own protocol and port
 * are used as they stand, which is the "port field may then be empty"
 * convenience the brief asks for — otherwise `Protocol` and `Port` are joined
 * onto `Host`, and `Port` is required: a console is rarely on 80/443, and a
 * typo that silently fell back to a default port would dial the wrong
 * service instead of refusing.
 */
function candidateUrlOf(values: FormValues): ConnectResult {
  const host = (values[CONNECT_HOST_FIELD] ?? '').trim()
  if (host === '') return { ok: false, field: CONNECT_HOST_FIELD, message: REQUIRED_MESSAGE }
  if (isWholeUrl(host)) return { ok: true, url: host }

  const port = (values[CONNECT_PORT_FIELD] ?? '').trim()
  if (port === '') return { ok: false, field: CONNECT_PORT_FIELD, message: REQUIRED_MESSAGE }
  if (!isValidPort(port)) return { ok: false, field: CONNECT_PORT_FIELD, message: PORT_RANGE_MESSAGE }

  const protocol = values[CONNECT_PROTOCOL_FIELD] === PROTOCOL_HTTP ? PROTOCOL_HTTP : PROTOCOL_HTTPS
  return { ok: true, url: `${protocol}://${host}:${port}` }
}

/**
 * The one validator the connect form submits through: the candidate above,
 * then `parseRemoteUrl` on it — whichever refused, in its own words.
 */
export function remoteUrlOf(values: FormValues): ConnectResult {
  const candidate = candidateUrlOf(values)
  if (!candidate.ok) return candidate

  const parsed = parseRemoteUrl(candidate.url)
  return parsed.ok ? { ok: true, url: parsed.url.origin } : { ok: false, message: parsed.message }
}

/** `https`'s and `http`'s default port, shown explicitly rather than left blank (2026-09-20). */
const DEFAULT_PORT_OF: Readonly<Record<string, string>> = { [PROTOCOL_HTTPS]: '443', [PROTOCOL_HTTP]: '80' }

/**
 * A known address split back into the three fields it came from — the saved
 * one (`src/tui/remote/saved.ts`) and `mcpcut --connect <url>`'s argument
 * (2026-09-20) both arrive as one origin, and the operator edits a HOST, a
 * PORT and a PROTOCOL rather than one opaque string. Chosen over reusing the
 * "whole URL in Host" shortcut (`isWholeUrl`) so that fixing a typo in one
 * part — the port most of all — does not mean retyping the whole address.
 *
 * `URL(...).port` is `''` for the scheme's own default (`https://h` has no
 * port in it at all), and this shows the NUMBER rather than leaving the field
 * blank: a blank Port is `required`'s territory for a bare host, and an
 * operator editing a form that already looked complete should not meet that
 * error the moment they touch a field they were not even changing.
 */
export function connectFormValuesOf(url: RemoteUrl): FormValues {
  const port = new URL(url.origin).port
  return {
    [CONNECT_HOST_FIELD]: url.hostname,
    [CONNECT_PORT_FIELD]: port === '' ? (DEFAULT_PORT_OF[url.scheme] ?? '') : port,
    [CONNECT_PROTOCOL_FIELD]: url.scheme,
  }
}

/** The connect form, prefilled from a known address rather than opened empty. */
export function connectFormOf(url: RemoteUrl): Form {
  const values = connectFormValuesOf(url)
  return formOf(CONNECT_FIELDS.map((spec) => ({ ...spec, initial: values[spec.name] ?? '' })))
}
