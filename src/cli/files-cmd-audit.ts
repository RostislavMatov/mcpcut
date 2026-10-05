import path from 'node:path'
import { parseArgs } from 'node:util'
import { createAgentsStore } from '../agents/store.js'
import { parseSince, type FileAuditActor, type FileAuditEntry, type FileAuditSubject } from '../files/audit.js'
import { fileAudit, type AuditAnswer } from '../files/audit-source.js'
import { canonicalPath } from '../files/paths.js'
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

/** `files audit` waits this long for Postgres to catch up before it answers from the journal. */
const CLI_INGEST_BUDGET_MS = 10_000
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

/** `for agent bot` / `for group devs`; empty for agent calls and edits of roots or trash. */
function subjectLabel(subject: FileAuditSubject | null): string {
  return subject === null ? '' : `for ${subject.kind} ${formatReadableField(subject.name)}`
}

/** `a` or `source -> destination`; empty when the record named no path. */
function pathsLabel(paths: readonly string[]): string {
  return paths.map(formatReadableField).join(' -> ')
}

export function formatAuditLine(entry: FileAuditEntry): string {
  const isAllow = entry.outcome === 'allow'
  const columns = [
    formatReadableField(entry.ts),
    actorLabel(entry.actor),
    ...(entry.outcome !== null ? [formatReadableField(entry.outcome)] : []),
    formatReadableField(entry.action),
    subjectLabel(entry.subject),
    pathsLabel(entry.paths),
    ...(entry.rule !== null && !isAllow ? [formatReadableField(entry.rule)] : []),
  ]
  return columns.filter((column) => column !== '').join(COLUMN_GAP)
}

/** The stderr footer: the count, why the list may be short, and the next step. */
function footerOf(result: AuditAnswer, cli: string): string {
  const [newest] = result.entries
  if (newest === undefined) return ''
  const shown = result.entries.length
  const lines = [`${shown} file operation(s)${result.source === 'postgres' ? ' from Postgres' : ''}`, `Full record: ${cli} show ${shellArg(newest.sessionId)}`]
  if (result.truncated) lines.push('Searched only the newest sessions or file calls — narrow with --since or --agent')
  if (result.hasMore) lines.push(`Showing the newest ${shown} — more with --limit ${Math.min(shown * 2, MAX_LIMIT)}`)
  return `${lines.join('\n')}\n`
}

async function emptyHint(opts: FilesCliOptions, hasFilters: boolean): Promise<string> {
  const journalDir = opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}
  const roots = await createRootsStore(journalDir).list()
  const cli = cliCommand(opts.env)
  if (roots.length === 0) return `No file operations recorded. Declare a folder first: ${cli} files root add <folder>\n`
  if (hasFilters) return `No file operations match these filters — drop one or widen --since.\nAll file operations: ${cli} files audit\n`
  const agents = await createAgentsStore(journalDir).listAgents()
  const step = grantNextStep(opts.env ?? process.env, agents, roots[0]?.path ?? '')
  return `No file operations recorded yet. Agents reach folders through connect — give one access:\n${step}`
}

/** The path as typed (made absolute) and, when symlinks lead elsewhere, its canonical spelling too. */
async function pathQueryOf(raw: string): Promise<{ readonly path: string; readonly pathAliases: readonly string[] }> {
  const resolved = path.resolve(raw)
  const canonical = await canonicalPath(resolved)
  return { path: resolved, pathAliases: canonical === null || canonical === resolved ? [] : [canonical] }
}

export async function runAudit(args: string[], io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const parsed = parseAuditArgs(args)
  if (parsed === undefined) return fail(io, FILES_USAGE.trimEnd())
  const since = parsed.since === undefined ? undefined : parseSince(parsed.since, (opts.clock ?? (() => new Date()))())
  if (since === null) return fail(io, '--since takes a day as YYYY-MM-DD or an age as <N>d (1 to 3650 days), e.g. --since 7d')
  if (parsed.limit !== undefined && (!LIMIT_PATTERN.test(parsed.limit) || Number(parsed.limit) > MAX_LIMIT)) {
    return fail(io, `--limit takes a whole number from 1 to ${MAX_LIMIT}, e.g. --limit 200`)
  }
  if (parsed.path === '') return fail(io, '--path takes a file or folder, e.g. --path ~/project/notes.md')
  const pathQuery = parsed.path === undefined ? {} : await pathQueryOf(parsed.path)

  const result = await fileAudit(
    {
      limit: parsed.limit === undefined ? DEFAULT_LIMIT : Number(parsed.limit),
      ...pathQuery,
      ...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
      ...(since !== undefined ? { since } : {}),
    },
    {
      cli: cliCommand(opts.env),
      budgetMs: CLI_INGEST_BUDGET_MS,
      ...(opts.journalDir !== undefined ? { journalDir: opts.journalDir } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.db?.loadPg !== undefined ? { loadPg: opts.db.loadPg } : {}),
      ...(opts.db?.schema !== undefined ? { schema: opts.db.schema } : {}),
      ...(opts.db?.onOpen !== undefined ? { onOpen: opts.db.onOpen } : {}),
    },
  )
  if (result.notice !== undefined) io.stderr.write(`${result.notice}\n`)
  if (parsed.json === true) {
    io.stdout.write(
      `${JSON.stringify({ entries: result.entries, hasMore: result.hasMore, truncated: result.truncated, source: result.source })}\n`,
    )
  } else {
    result.entries.forEach((entry) => io.stdout.write(`${formatAuditLine(entry)}\n`))
  }
  const hasFilters = parsed.path !== undefined || parsed.agent !== undefined || parsed.since !== undefined
  io.stderr.write(result.entries.length === 0 ? await emptyHint(opts, hasFilters) : footerOf(result, cliCommand(opts.env)))
  return 0
}
