import type { JournalRecord } from '../journal/record.js'
import { FILES_SERVER_NAME } from './constants.js'

/**
 * How a journal record becomes an audit entry (ADR-0020 §5) — shared by the
 * journal walk (`audit.ts`) and the Postgres ingest, so both map a record the
 * same way. Records come from disk, so every field is read defensively: one
 * that is missing or of the wrong type drops the record or the value, never
 * throws.
 */

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


const UNATTRIBUTED = 'unattributed'
const UNKNOWN_VIA = 'unknown'

/** Actions that act on a whole tree: they also match a path INSIDE the one they name. */
export const TREE_ACTIONS: ReadonlySet<string> = new Set([
  'move_file',
  'delete_file',
  'files.grant',
  'files.revoke',
  'files.root.add',
  'files.root.remove',
  'files.trash.restore',
  'files.index.on',
  'files.index.off',
])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function entryOfCall(sessionId: string, record: JournalRecord): FileAuditEntry | undefined {
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

export type EditEntry = FileAuditEntry & { readonly agentOfEdit: string | undefined }

export function entryOfEdit(record: JournalRecord): EditEntry | undefined {
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

export function subjectOf(payload: Record<string, unknown>): FileAuditSubject | null {
  const agent = stringOf(payload['agent'])
  if (agent !== undefined) return { kind: 'agent', name: agent }
  const group = stringOf(payload['group'])
  return group === undefined ? null : { kind: 'group', name: group }
}

