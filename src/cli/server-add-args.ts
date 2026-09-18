import { parseArgs } from 'node:util'
import { formatReadableField } from '../journal/format.js'

/**
 * The argument layer of `server add`: usage text, flag shapes, `K=V` parsing
 * and the raw record it assembles for the registry schema. Split out of
 * `server-cmd.ts` for the file-size budget, the same way
 * `server-status-cmd.ts` and `server-remove-cascade.ts` were — this module
 * knows only about argv and never touches a store.
 */

export const ADD_USAGE = `Usage:
  server add <name> --transport stdio|http
    stdio:  --command <cmd> [--args a,b,c] [--env K=V]...
    http:   --url <url> [--header K=V]... [--protocol sessionful|stateless|auto]
  Env/header values are either non-secret literals or vault references (vault:<name>).
  Needs a personal admin token in MCP_ADMIN_TOKEN, role owner.
`

/** Flag values `server add` accepts, straight out of `parseArgs`. */
interface AddFlagValues {
  readonly transport?: string | undefined
  readonly command?: string | undefined
  readonly args?: string | undefined
  readonly env?: string[] | undefined
  readonly url?: string | undefined
  readonly header?: string[] | undefined
  readonly protocol?: string | undefined
}

/** Flags of `server add` that take a value (used by `normalizeInlineValues`). */
const ADD_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--transport',
  '--command',
  '--args',
  '--env',
  '--url',
  '--header',
  '--protocol',
])

/**
 * Rewrites `--flag value` into `--flag=value` for known value-taking flags.
 * `parseArgs` rejects a space-separated value that starts with a dash
 * (`--args -y,...` → "argument is ambiguous"), but that is exactly how the
 * documented onboarding script passes stdio args. Joining the pair is
 * semantically identical for every non-dash value and simply also accepts
 * dash-leading ones.
 */
function normalizeInlineValues(args: readonly string[]): string[] {
  const normalized: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i]
    const next = args[i + 1]
    if (current !== undefined && ADD_VALUE_FLAGS.has(current) && next !== undefined) {
      normalized.push(`${current}=${next}`)
      i += 1
      continue
    }
    if (current !== undefined) {
      normalized.push(current)
    }
  }
  return normalized
}

type PairsResult =
  | { readonly ok: true; readonly map: Record<string, string> | undefined }
  | { readonly ok: false; readonly message: string }

/**
 * Parses repeatable `K=V` flag values into a map. The accumulator has a null
 * prototype so a `__proto__` key becomes an own property (which the schema
 * pre-scan then rejects loudly) instead of silently rewiring the prototype.
 */
function parseKeyValuePairs(values: readonly string[] | undefined, flag: string): PairsResult {
  if (values === undefined || values.length === 0) {
    return { ok: true, map: undefined }
  }
  const map: Record<string, string> = Object.create(null) as Record<string, string>
  for (const pair of values) {
    const separatorIndex = pair.indexOf('=')
    if (separatorIndex <= 0) {
      return { ok: false, message: `invalid ${flag} value "${formatReadableField(pair)}": expected K=V` }
    }
    const key = pair.slice(0, separatorIndex)
    if (Object.hasOwn(map, key)) {
      return { ok: false, message: `duplicate ${flag} key "${formatReadableField(key)}"` }
    }
    map[key] = pair.slice(separatorIndex + 1)
  }
  return { ok: true, map }
}

type CandidateResult =
  | { readonly ok: true; readonly candidate: Record<string, unknown> }
  | { readonly ok: false; readonly message: string }

/**
 * Assembles the raw record from CLI flags. Every provided flag is included —
 * even ones that do not belong to the chosen transport — so the strict
 * schema reports a precise "unrecognized key" error instead of this function
 * silently dropping, say, `--url` on a stdio server.
 */
export function buildCandidate(name: string, values: AddFlagValues): CandidateResult {
  if (values.transport === undefined) {
    return { ok: false, message: '--transport is required (stdio|http)' }
  }
  const env = parseKeyValuePairs(values.env, '--env')
  if (!env.ok) return env
  const headers = parseKeyValuePairs(values.header, '--header')
  if (!headers.ok) return headers

  const candidate: Record<string, unknown> = { name, transport: values.transport }
  if (values.command !== undefined) candidate['command'] = values.command
  if (values.args !== undefined) candidate['args'] = values.args.split(',')
  if (env.map !== undefined) candidate['env'] = env.map
  if (values.url !== undefined) candidate['url'] = values.url
  if (headers.map !== undefined) candidate['headers'] = headers.map
  if (values.protocol !== undefined) candidate['protocol'] = values.protocol
  return { ok: true, candidate }
}

/** Parses `server add` argv into the name positional and flag values; `undefined` on any shape error. */
export function parseAddArgs(args: string[]): { name: string; values: AddFlagValues } | undefined {
  try {
    const parsed = parseArgs({
      args: normalizeInlineValues(args),
      options: {
        transport: { type: 'string' },
        command: { type: 'string' },
        args: { type: 'string' },
        env: { type: 'string', multiple: true },
        url: { type: 'string' },
        header: { type: 'string', multiple: true },
        protocol: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    const name = parsed.positionals.length === 1 ? parsed.positionals[0] : undefined
    return name !== undefined ? { name, values: parsed.values } : undefined
  } catch {
    return undefined
  }
}

