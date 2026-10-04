import path from 'node:path'
import { parseArgs } from 'node:util'
import { createAgentsStore } from '../agents/store.js'
import { parseSince, queryFileAudit, type FileAuditActor, type FileAuditEntry, type FileAuditResult } from '../files/audit.js'
import { createRootsStore } from '../files/roots-store.js'
import { formatReadableField } from '../journal/format.js'
import type { AgentCliIo } from './agent-cmd.js'
import { FILES_USAGE, grantNextStep } from './files-cmd-format.js'
import type { FilesCliOptions } from './files-cmd.js'
import { cliCommand, shellArg } from './next-step.js'

/**
 * `mcpcut files audit` (ADR-0020 §5): who touched a path — a read-only view of
 * the journal like `sessions` and `show`, so no token. One line per file
 * operation on stdout; counts, truncation and the next step on stderr.
 */

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
const LIMIT_PATTERN = /^[1-9]\d{0,3}$/
const COLUMN_GAP = '  '

interface AuditArgs {
  readonly path?: string
  readonly agent?: string
  readonly since?: string
  readonly limit?: string
  readonly json?: boolean
}

function parseAuditArgs(args: readonly string[]): AuditArgs | undefined {
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        path: { type: 'string' },
        agent: { type: 'string' },
        since: { type: 'string' },
        limit: { type: 'string' },
        json: { type: 'boolean' },
      },
      allowPositionals: false,
      strict: true,
    })
    return parsed.values as AuditArgs
  } catch {
    return undefined
  }
}

function fail(io: AgentCliIo, line: string): number {
  io.stderr.write(`${line}\n`)
  return 1
}

function actorLabel(actor: FileAuditActor): string {
  if (actor.kind === 'agent') return formatReadableField(actor.name ?? '-')
  return `admin ${formatReadableField(actor.name)} (${formatReadableField(actor.via)})`
}

/** `a` or `source -> destination`; empty when the record named no path. */
function pathsLabel(paths: readonly string[]): string {
  return paths.map(formatReadableField).join(' -> ')
}

export function formatAuditLine(entry: FileAuditEntry): string {
  const isAllow = entry.outcome === 'allow'
  const columns = [
    entry.ts,
    actorLabel(entry.actor),
    ...(entry.outcome !== null ? [formatReadableField(entry.outcome)] : []),
    formatReadableField(entry.action),
    pathsLabel(entry.paths),
    ...(entry.rule !== null && !isAllow ? [formatReadableField(entry.rule)] : []),
  ]
  return columns.filter((column) => column !== '').join(COLUMN_GAP)
}

/** The stderr footer: the count, why the list may be short, and the next step. */
function footerOf(result: FileAuditResult, cli: string): string {
  const [newest] = result.entries
  if (newest === undefined) return ''
  const shown = result.entries.length
  const lines = [`${shown} file operation(s)`, `Full record: ${cli} show ${shellArg(newest.sessionId)}`]
  if (result.truncated) lines.push('Searched only the newest sessions — narrow with --since or --agent')
  if (result.hasMore) lines.push(`Showing the newest ${shown} — more with --limit ${Math.min(shown * 2, MAX_LIMIT)}`)
  return `${lines.join('\n')}\n`
}

async function emptyHint(opts: FilesCliOptions, hasFilters: boolean): Promise<string> {
  const journalDir = opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}
  const roots = await createRootsStore(journalDir).list()
  const cli = cliCommand(opts.env)
  if (roots.length === 0) return `No file operations recorded. Declare a folder first: ${cli} files root add <folder>\n`
  if (hasFilters) return 'No file operations match these filters — drop one or widen --since.\n'
  const agents = await createAgentsStore(journalDir).listAgents()
  const step = grantNextStep(opts.env ?? process.env, agents, roots[0]?.path ?? '')
  return `No file operations recorded yet. Agents reach folders through connect — give one access:\n${step}`
}

export async function runAudit(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const parsed = parseAuditArgs(args)
  if (parsed === undefined) return fail(io, FILES_USAGE.trimEnd())
  const since = parsed.since === undefined ? undefined : parseSince(parsed.since, (opts.clock ?? (() => new Date()))())
  if (since === null) return fail(io, '--since takes a day as YYYY-MM-DD or an age as <N>d (1 to 3650 days), e.g. --since 7d')
  if (parsed.limit !== undefined && (!LIMIT_PATTERN.test(parsed.limit) || Number(parsed.limit) > MAX_LIMIT)) {
    return fail(io, `--limit takes a whole number from 1 to ${MAX_LIMIT}, e.g. --limit 200`)
  }

  const result = await queryFileAudit(
    {
      limit: parsed.limit === undefined ? DEFAULT_LIMIT : Number(parsed.limit),
      ...(parsed.path !== undefined ? { path: path.resolve(parsed.path) } : {}),
      ...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
      ...(since !== undefined ? { since } : {}),
    },
    opts.journalDir !== undefined ? { dir: opts.journalDir } : {},
  )
  if (parsed.json === true) {
    io.stdout.write(`${JSON.stringify({ entries: result.entries, hasMore: result.hasMore, truncated: result.truncated })}\n`)
  } else {
    result.entries.forEach((entry) => io.stdout.write(`${formatAuditLine(entry)}\n`))
  }
  const hasFilters = parsed.path !== undefined || parsed.agent !== undefined || parsed.since !== undefined
  io.stderr.write(result.entries.length === 0 ? await emptyHint(opts, hasFilters) : footerOf(result, cliCommand(opts.env)))
  return 0
}
