import { splitKeyValueLine } from '../server-form.js'

/** Parses a `K=V` per line block into a plain map; blank lines ignored. */
function parseKeyValueLines(block: string | undefined): Record<string, string> | undefined {
  if (block === undefined || block.trim() === '') return undefined
  const map: Record<string, string> = Object.create(null) as Record<string, string>
  for (const rawLine of block.split(/\r?\n/)) {
    const pair = splitKeyValueLine(rawLine)
    if (pair === null) continue
    map[pair.key] = pair.value
  }
  return Object.keys(map).length > 0 ? map : undefined
}

/**
 * Assembles a raw candidate record from the add form. Every provided field is
 * included even if it does not belong to the chosen transport, so the strict
 * schema reports a precise "unrecognized key" instead of silently dropping it —
 * exactly the CLI's `buildCandidate` behaviour.
 */
export function buildCandidate(fields: Readonly<Record<string, string>>): Record<string, unknown> {
  const candidate: Record<string, unknown> = { name: fields.name ?? '', transport: fields.transport ?? '' }
  if (fields.command !== undefined && fields.command !== '') candidate.command = fields.command
  if (fields.args !== undefined && fields.args.trim() !== '') {
    candidate.args = fields.args
      .split(/\r?\n/)
      .map((arg) => arg.trim())
      .filter((arg) => arg !== '')
  }
  const env = parseKeyValueLines(fields.env)
  if (env !== undefined) candidate.env = env
  if (fields.url !== undefined && fields.url !== '') candidate.url = fields.url
  const headers = parseKeyValueLines(fields.headers)
  if (headers !== undefined) candidate.headers = headers
  // The protocol radios always post a value (a radio group has a default),
  // so for a stdio submission the field is form plumbing, not operator input —
  // including it would make EVERY stdio registration from the browser fail
  // strict validation with "unrecognized key protocol". Only http owns it.
  if (fields.transport === 'http' && fields.protocol !== undefined && fields.protocol !== '') {
    candidate.protocol = fields.protocol
  }
  return candidate
}
