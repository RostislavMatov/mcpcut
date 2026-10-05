import { TREE_ACTIONS, entryOfCall, entryOfEdit, type EditEntry, type FileAuditEntry } from '../audit-entry.js'
import { ACCESS_EDIT_SESSION_ID } from '../../journal/access-edit-record.js'
import type { RecordAfterSeq } from '../../journal/db-read-after.js'
import { pathModuleOf } from '../names.js'
import { cleanOptional, cleanText } from './clean-text.js'
import { keyPrefix, pathMatchKey } from './path-key.js'

/** A journal record mapped to the rows of the index (ADR-0020 §6); every string is cleaned for Postgres. */

/** Tools that change the file system: the catalog re-stats what they named. */
const MUTATING_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'create_directory', 'move_file', 'delete_file'])
const ALLOW_OUTCOME = 'allow'

interface EventRow {
  readonly journal_seq: number
  readonly record_id: string
  readonly session_id: string
  readonly ts: string
  readonly actor_kind: string
  readonly actor_name: string | null
  readonly actor_via: string | null
  readonly action: string
  readonly outcome: string | null
  readonly rule: string | null
  readonly subject_kind: string | null
  readonly subject_name: string | null
  readonly agent_key: string | null
  readonly paths: readonly string[]
}

interface PathRow {
  readonly journal_seq: number
  readonly ord: number
  readonly path_key: string
  readonly key_prefix: string
  readonly is_tree: boolean
}

export interface Mapped {
  readonly event: EventRow
  readonly pathRows: readonly PathRow[]
}

export function mapRecord(row: RecordAfterSeq, platform: NodeJS.Platform): Mapped | undefined {
  const isEdit = row.sessionId === ACCESS_EDIT_SESSION_ID
  const mapped = isEdit ? entryOfEdit(row.record) : entryOfCall(row.sessionId, row.record)
  if (mapped === undefined) return undefined
  const agentKey = agentKeyOf(mapped)
  const entry = cleanEntry(mapped)
  return { event: eventRowOf(row.seq, entry, cleanOptional(agentKey)), pathRows: pathRowsOf(row.seq, entry, platform) }
}

/** The entry with every string made safe for Postgres (NUL and lone surrogates replaced). */
function cleanEntry(entry: FileAuditEntry): FileAuditEntry {
  const actor =
    entry.actor.kind === 'admin'
      ? { kind: 'admin' as const, name: cleanText(entry.actor.name), via: cleanText(entry.actor.via) }
      : { kind: 'agent' as const, name: cleanOptional(entry.actor.name) }
  return {
    ts: cleanText(entry.ts),
    sessionId: cleanText(entry.sessionId),
    recordId: cleanText(entry.recordId),
    actor,
    action: cleanText(entry.action),
    outcome: cleanOptional(entry.outcome),
    rule: cleanOptional(entry.rule),
    subject: entry.subject === null ? null : { kind: entry.subject.kind, name: cleanText(entry.subject.name) },
    paths: entry.paths.map(cleanText),
  }
}

/** What `--agent` matches: the calling agent, or the agent an admin edit was for. */
function agentKeyOf(entry: FileAuditEntry | EditEntry): string | null {
  if ('agentOfEdit' in entry) return entry.agentOfEdit ?? null
  return entry.actor.kind === 'agent' ? entry.actor.name : null
}

function eventRowOf(seq: number, entry: FileAuditEntry, agentKey: string | null): EventRow {
  return {
    journal_seq: seq,
    record_id: entry.recordId,
    session_id: entry.sessionId,
    ts: entry.ts,
    actor_kind: entry.actor.kind,
    actor_name: entry.actor.name,
    actor_via: entry.actor.kind === 'admin' ? entry.actor.via : null,
    action: entry.action,
    outcome: entry.outcome,
    rule: entry.rule,
    subject_kind: entry.subject?.kind ?? null,
    subject_name: entry.subject?.name ?? null,
    agent_key: agentKey,
    paths: entry.paths,
  }
}

function pathRowOf(seq: number, ord: number, key: string, isTree: boolean): PathRow {
  return { journal_seq: seq, ord, path_key: key, key_prefix: keyPrefix(key), is_tree: isTree }
}

function pathRowsOf(seq: number, entry: FileAuditEntry, platform: NodeJS.Platform): readonly PathRow[] {
  const isAbsolute = pathModuleOf(platform).isAbsolute
  const isTree = TREE_ACTIONS.has(entry.action)
  return entry.paths.flatMap((value, ord) =>
    isAbsolute(value) ? [pathRowOf(seq, ord, pathMatchKey(value, platform), isTree)] : [],
  )
}

export function touchedOf(mapped: readonly Mapped[]): string[] {
  return mapped
    .filter(({ event }) => event.actor_kind === 'agent' && event.outcome === ALLOW_OUTCOME && MUTATING_TOOLS.has(event.action))
    .flatMap(({ event }) => [...event.paths])
}
