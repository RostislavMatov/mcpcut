import path from 'node:path'
import { ACCESS_EDIT_SESSION_ID } from '../journal/access-edit-record.js'
import type { JournalRecord } from '../journal/record.js'
import { MAX_PAGE_LIMIT, searchAllSessions, searchSession } from '../journal/search.js'
import { FILES_SERVER_NAME } from './constants.js'
import { isWithinOn, lexicalKey } from './names.js'

/**
 * Who touched a path (ADR-0020 §5): the file module's own audit read over the
 * journal. Every call of the built-in `files` server is a `decision` record
 * (arguments in `payload`, who and what in `decision`); every admin edit of
 * roots, rules or trash is an `access-edit` record in the reserved session.
 * Records come from disk, so every field is read defensively: one that is
 * missing or of the wrong type drops the record or the value, never throws.
 */

export interface FileAuditQuery {
  /** Absolute; an entry matches when it touched this path or something inside it. */
  readonly path?: string
  /** Other spellings of `path` (its canonical form through symlinks); matched like `path`. */
  readonly pathAliases?: readonly string[]
  readonly agent?: string
  /** `YYYY-MM-DD`, already parsed (`parseSince`). */
  readonly since?: string
  /** 1..1000. */
  readonly limit: number
}

export type FileAuditActor =
  | { readonly kind: 'agent'; readonly name: string | null }
  | { readonly kind: 'admin'; readonly name: string; readonly via: string }

/** Whom an admin edit was for. */
export interface FileAuditSubject {
  readonly kind: 'agent' | 'group'
  readonly name: string
}

export interface FileAuditEntry {
  readonly ts: string
  readonly sessionId: string
  readonly recordId: string
  readonly actor: FileAuditActor
  /** Tool name (`read_file` …) or admin action (`files.grant` …). */
  readonly action: string
  /** Decision outcome; null for admin edits. */
  readonly outcome: string | null
  /** Decision rule (the reason of a deny); null for admin edits. */
  readonly rule: string | null
  /** The agent or group an admin edit was for; null for agent calls and for edits of roots or trash. */
  readonly subject: FileAuditSubject | null
  /** `[path]` or `[source, destination]`; may be empty. */
  readonly paths: readonly string[]
}

export interface FileAuditResult {
  /** Newest first, at most `limit`. */
  readonly entries: readonly FileAuditEntry[]
  /** More matches than `limit`. */
  readonly hasMore: boolean
  /** The journal walk stopped early (sessions, bytes or time budget). */
  readonly truncated: boolean
}

export interface FileAuditOptions {
  readonly dir?: string
  readonly platform?: NodeJS.Platform
}

const MIN_LIMIT = 1
const SINCE_DAYS_PATTERN = /^([1-9]\d{0,3})d$/
const SINCE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_SINCE_DAYS = 3650
const MS_PER_DAY = 86_400_000
/** Pages of admin edits read before the walk is reported as truncated. */
const MAX_EDIT_PAGES = 20
const UNATTRIBUTED = 'unattributed'
const UNKNOWN_VIA = 'unknown'

/** Actions that act on a whole tree: they also match a path INSIDE the one they name. */
const TREE_ACTIONS: ReadonlySet<string> = new Set([
  'move_file',
  'delete_file',
  'files.grant',
  'files.revoke',
  'files.root.add',
  'files.root.remove',
  'files.trash.restore',
])

/** `YYYY-MM-DD` or `<N>d` (1..3650) → the UTC day `YYYY-MM-DD`; null when it is neither. */
export function parseSince(raw: string, now: Date): string | null {
  if (SINCE_DATE_PATTERN.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00.000Z`)
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw ? null : raw
  }
  const days = SINCE_DAYS_PATTERN.exec(raw)?.[1]
  if (days === undefined || Number(days) > MAX_SINCE_DAYS) return null
  return new Date(now.getTime() - Number(days) * MS_PER_DAY).toISOString().slice(0, 10)
}

export async function queryFileAudit(query: FileAuditQuery, opts: FileAuditOptions = {}): Promise<FileAuditResult> {
  const platform = opts.platform ?? process.platform
  const limit = Math.min(MAX_PAGE_LIMIT, Math.max(MIN_LIMIT, Math.floor(query.limit)))
  const [calls, edits] = await Promise.all([readCalls(query, opts), readEdits(query, opts)])
  const matcher = query.path === undefined ? undefined : pathMatcher([query.path, ...(query.pathAliases ?? [])], platform)
  const matching = [...calls.entries, ...edits.entries]
    .filter((entry) => matcher === undefined || matcher(entry))
    .sort(newestFirst)
  return {
    entries: matching.slice(0, limit),
    hasMore: matching.length > limit,
    truncated: calls.truncated || edits.truncated,
  }
}

interface Collected {
  readonly entries: readonly FileAuditEntry[]
  readonly truncated: boolean
}

async function readCalls(query: FileAuditQuery, opts: FileAuditOptions): Promise<Collected> {
  const found = await searchAllSessions({
    kind: 'decision',
    serverName: FILES_SERVER_NAME,
    limit: MAX_PAGE_LIMIT,
    ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
    ...(query.agent !== undefined ? { agentName: query.agent } : {}),
    ...(query.since !== undefined ? { from: query.since } : {}),
  })
  const entries = found.hits.flatMap((hit) => entryOfCall(hit.sessionId, hit.record) ?? [])
  return { entries, truncated: found.truncated }
}

async function readEdits(query: FileAuditQuery, opts: FileAuditOptions): Promise<Collected> {
  const records: JournalRecord[] = []
  let truncated = false
  for (let page = 0; page < MAX_EDIT_PAGES; page += 1) {
    const result = await searchSession(ACCESS_EDIT_SESSION_ID, {
      kind: 'access-edit',
      limit: MAX_PAGE_LIMIT,
      offset: page * MAX_PAGE_LIMIT,
      ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
      ...(query.since !== undefined ? { from: query.since } : {}),
    })
    records.push(...result.records)
    truncated = truncated || result.truncated
    if (!result.hasMore) break
    if (page === MAX_EDIT_PAGES - 1) truncated = true
  }
  const entries = records
    .flatMap((record) => entryOfEdit(record) ?? [])
    .filter((entry) => query.agent === undefined || entry.agentOfEdit === query.agent)
    .map(({ agentOfEdit: _agent, ...entry }) => entry)
  return { entries, truncated }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function entryOfCall(sessionId: string, record: JournalRecord): FileAuditEntry | undefined {
  const decision = asRecord(record.decision)
  if (decision === undefined || decision['serverName'] !== FILES_SERVER_NAME) return undefined
  const action = stringOf(decision['toolName'])
  if (action === undefined) return undefined
  const payload = asRecord(record.payload) ?? {}
  return {
    ts: record.ts,
    sessionId,
    recordId: record.id,
    actor: { kind: 'agent', name: stringOf(decision['agentName']) ?? null },
    action,
    outcome: stringOf(decision['outcome']) ?? null,
    rule: stringOf(decision['rule']) ?? null,
    subject: null,
    paths: [payload['path'], payload['source'], payload['destination']].flatMap((value) => stringOf(value) ?? []),
  }
}

type EditEntry = FileAuditEntry & { readonly agentOfEdit: string | undefined }

function entryOfEdit(record: JournalRecord): EditEntry | undefined {
  const payload = asRecord(record.payload)
  const action = stringOf(payload?.['action'])
  if (payload === undefined || action === undefined || !action.startsWith('files.')) return undefined
  const actor = asRecord(payload['actor'])
  return {
    ts: record.ts,
    sessionId: record.sessionId,
    recordId: record.id,
    actor: {
      kind: 'admin',
      name: stringOf(actor?.['adminName']) ?? UNATTRIBUTED,
      via: stringOf(actor?.['via']) ?? UNKNOWN_VIA,
    },
    action,
    outcome: null,
    rule: null,
    subject: subjectOf(payload),
    paths: stringOf(payload['path']) === undefined ? [] : [payload['path'] as string],
    agentOfEdit: stringOf(payload['agent']),
  }
}

function subjectOf(payload: Record<string, unknown>): FileAuditSubject | null {
  const agent = stringOf(payload['agent'])
  if (agent !== undefined) return { kind: 'agent', name: agent }
  const group = stringOf(payload['group'])
  return group === undefined ? null : { kind: 'group', name: group }
}

function newestFirst(left: FileAuditEntry, right: FileAuditEntry): number {
  if (left.ts !== right.ts) return left.ts < right.ts ? 1 : -1
  if (left.recordId === right.recordId) return 0
  return left.recordId < right.recordId ? 1 : -1
}

/**
 * Whether an entry touched one of the query spellings or something inside it —
 * or, for a whole-tree action, a folder holding it. The spellings are keyed
 * once, not once per entry.
 */
function pathMatcher(queries: readonly string[], platform: NodeJS.Platform): (entry: FileAuditEntry) => boolean {
  const pathModule = platform === 'win32' ? path.win32 : path.posix
  const wanted = queries.filter((query) => pathModule.isAbsolute(query)).map((query) => lexicalKey(query, platform))
  return (entry) => {
    const isTree = TREE_ACTIONS.has(entry.action)
    const keys = entry.paths.filter((value) => pathModule.isAbsolute(value)).map((value) => lexicalKey(value, platform))
    return wanted.some((query) =>
      keys.some((value) => isWithinOn(query, value, platform) || (isTree && isWithinOn(value, query, platform))),
    )
  }
}
