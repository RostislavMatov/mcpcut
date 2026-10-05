import { ACCESS_EDIT_SESSION_ID } from '../../../src/journal/access-edit-record.js'
import type { JournalRecord } from '../../../src/journal/record.js'
import { createJournalSink } from '../../../src/journal/sink.js'

/** Real journal records for the Postgres tests (same shapes as `tests/files/audit.test.ts`). */

let counter = 0

function nextId(): string {
  counter += 1
  return `01ARZ3NDEKTSV4RRFFQ69G${String(counter).padStart(4, '0')}`
}

export interface CallInput {
  readonly ts?: string
  readonly agent?: string
  readonly tool?: string
  readonly outcome?: string
  readonly rule?: string
  readonly server?: string
  readonly payload?: unknown
}

export function call(input: CallInput): JournalRecord {
  return {
    id: nextId(),
    ts: input.ts ?? '2026-10-04T10:00:00.000Z',
    sessionId: 'x',
    direction: 'client→server',
    kind: 'decision',
    payload: input.payload ?? {},
    decision: {
      outcome: input.outcome ?? 'allow',
      rule: input.rule ?? 'files: allowed',
      serverName: input.server ?? 'files',
      toolName: input.tool ?? 'read_file',
      toolClass: 'read',
      quarantineState: 'known',
      argsHash: 'h',
      ...(input.agent !== undefined ? { agentName: input.agent } : {}),
    },
  } as unknown as JournalRecord
}

export function edit(ts: string, payload: Record<string, unknown>): JournalRecord {
  return {
    id: nextId(),
    ts,
    sessionId: ACCESS_EDIT_SESSION_ID,
    direction: 'client→server',
    kind: 'access-edit',
    payload: { actor: { adminName: 'ann', role: 'owner', via: 'cli' }, ...payload },
  }
}

export async function writeJournal(dir: string, sessionId: string, records: readonly JournalRecord[]): Promise<void> {
  const sink = createJournalSink(sessionId, { dir })
  for (const entry of records) sink.write({ ...entry, sessionId })
  await sink.close()
}
