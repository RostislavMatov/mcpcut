import { VAULT_REF_PREFIX } from '../registry/constants.js'
import { looksLikeSecretLiteral, type ServerRecord } from '../registry/schema.js'

/**
 * The register-server form's editable state, shared by the page that renders
 * it and the handler that answers a rejected submission.
 *
 * The reason this is its own module: a 400 must re-render the form with what
 * the operator typed (retyping eight fields to fix one is why operators paste
 * secrets in the first place), and that re-render is the one place where a
 * value the validator just called a secret could be echoed straight back into
 * the response. Deciding what is echoable is therefore a named, tested
 * operation with exactly one implementation — not a detail of a page template.
 *
 * The rule is the registry schema's own: `looksLikeSecretLiteral` is the
 * function that rejected the submission, so a value it flags is never put back
 * into the document. A `vault:` reference is never a secret and always
 * survives.
 */

/** The eight editable fields of the register-server form, verbatim. */
export interface ServerFormValues {
  readonly name: string
  readonly transport: string
  readonly command: string
  readonly args: string
  readonly url: string
  readonly protocol: string
  readonly env: string
  readonly headers: string
}

/** A blank form: what `/servers` renders when nothing has been submitted. */
export const EMPTY_SERVER_FORM: ServerFormValues = {
  name: '',
  transport: '',
  command: '',
  args: '',
  url: '',
  protocol: '',
  env: '',
  headers: '',
}

/** One `K=V` line of an env/headers block, or `null` when it is not a pair. */
export interface KeyValueLine {
  readonly key: string
  readonly value: string
}

/** Splits one raw textarea line into `K=V`; `null` for blank/keyless lines. */
export function splitKeyValueLine(rawLine: string): KeyValueLine | null {
  const line = rawLine.trim()
  const eq = line.indexOf('=')
  if (eq <= 0) return null
  return { key: line.slice(0, eq), value: line.slice(eq + 1) }
}

/**
 * True when putting `value` (stored under `key`) back into the response would
 * echo a secret. Mirrors the schema exactly: a well-formed-looking `vault:`
 * reference is a pointer, never a secret; everything else is judged by the
 * same key/value heuristics that produced the validation error.
 */
function isSecretBearing(key: string, value: string): boolean {
  if (value.startsWith(VAULT_REF_PREFIX)) return false
  return looksLikeSecretLiteral(key, value)
}

/**
 * A single-line field's echoable form. The form field's own name (`command`,
 * `url`, ...) carries no secrecy declaration, so only the VALUE's shape is
 * judged — hence the empty key.
 */
function echoableScalar(value: string | undefined): string {
  if (value === undefined || value === '') return ''
  return isSecretBearing('', value) ? '' : value
}

/**
 * An env/headers block's echoable form: the offending `K=V` lines are dropped
 * whole (key included — the error banner already names the key), so the rest
 * of a long block is not lost along with the one bad line.
 */
function echoableLines(block: string | undefined): string {
  if (block === undefined || block === '') return ''
  const kept = block.split(/\r?\n/).filter((rawLine) => !isSecretBearingLine(rawLine))
  return kept.join('\n')
}

function isSecretBearingLine(rawLine: string): boolean {
  const pair = splitKeyValueLine(rawLine)
  if (pair === null) {
    // Not a `K=V` pair — it cannot be stored, but it can still be a pasted
    // secret, so it is judged on its value shape alone.
    return rawLine.trim() !== '' && isSecretBearing('', rawLine.trim())
  }
  return isSecretBearing(pair.key, pair.value)
}

/**
 * The submitted fields as they may be rendered back into the form after a
 * rejected submission: everything preserved except the parts that carry a
 * secret literal, which are removed.
 */
export function echoableServerForm(fields: Readonly<Record<string, string>>): ServerFormValues {
  return {
    name: echoableScalar(fields.name),
    transport: echoableScalar(fields.transport),
    command: echoableScalar(fields.command),
    args: echoableScalar(fields.args),
    url: echoableScalar(fields.url),
    protocol: echoableScalar(fields.protocol),
    env: echoableLines(fields.env),
    headers: echoableLines(fields.headers),
  }
}

/** `{K: V}` → the textarea's `K=V` per line block. */
function kvLines(map: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(map ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

/**
 * A stored registry record as the edit form's values. The record already
 * passed the schema (no secret literals can be stored), so everything is
 * echoable as-is; fields of the other transport render blank.
 */
export function serverRecordToForm(record: ServerRecord): ServerFormValues {
  if (record.transport === 'stdio') {
    return {
      name: record.name,
      transport: record.transport,
      command: record.command,
      args: (record.args ?? []).join('\n'),
      url: '',
      protocol: '',
      env: kvLines(record.env),
      headers: '',
    }
  }
  return {
    name: record.name,
    transport: record.transport,
    command: '',
    args: '',
    url: record.url,
    protocol: record.protocol,
    env: '',
    headers: kvLines(record.headers),
  }
}
