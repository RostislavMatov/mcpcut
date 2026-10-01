import { adoptEntry, type EntryVerdict, type Launcher } from './entry.js'

/**
 * `mcpcut adopt` (P3) over one config document: find the servers object,
 * judge each entry, and build the new document. Pure and immutable — the
 * parsed document handed in is never changed, so the caller can still
 * compare against it and back it up.
 */

/** What `adopt --undo` needs to put an entry back: only the two fields adopt changes, never `env`. */
export interface CommandLine {
  readonly command: string
  readonly args?: readonly string[] | undefined
}

export interface PlanRow {
  readonly name: string
  readonly verdict: EntryVerdict
  /** The entry's command line before adopt; present when it is going to be wrapped. */
  readonly before?: CommandLine
}

type JsonObject = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The object at `path`, or `undefined` when a key is missing or something other than an object is in the way. */
export function serversAt(doc: unknown, path: readonly string[]): JsonObject | undefined {
  let current: unknown = doc
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return isRecord(current) ? current : undefined
}

export function commandLineOf(entry: JsonObject): CommandLine {
  const args = entry['args']
  return Array.isArray(args) ? { command: String(entry['command']), args: args.map(String) } : { command: String(entry['command']) }
}

export function planServers(servers: JsonObject, launcher: Launcher, platform: NodeJS.Platform): readonly PlanRow[] {
  return Object.entries(servers).map(([name, entry]) => {
    const verdict = adoptEntry(name, entry, launcher, platform)
    return verdict.kind === 'wrap' && isRecord(entry) ? { name, verdict, before: commandLineOf(entry) } : { name, verdict }
  })
}

/** A new document with `entries` replacing the same-named servers at `path`; key order and everything else kept. */
export function withEntries(doc: unknown, path: readonly string[], entries: Readonly<Record<string, unknown>>): unknown {
  const [key, ...rest] = path
  if (key === undefined) {
    const servers = isRecord(doc) ? doc : {}
    return Object.fromEntries(Object.entries(servers).map(([name, entry]) => [name, Object.hasOwn(entries, name) ? entries[name] : entry]))
  }
  const parent = isRecord(doc) ? doc : {}
  return { ...parent, [key]: withEntries(parent[key], rest, entries) }
}
