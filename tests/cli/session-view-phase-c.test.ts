import { describe, expect, test } from 'vitest'
import { formatRecordsReadable } from '../../src/cli/session-view.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { renderRecordRow } from '../../src/ui/pages/journal-parts.js'

/**
 * Decision M36 phase C records as people read them: `mcpcut show` names why
 * the agent left (or why the session ended) and prints no `null` for records
 * that carry no arguments; the web journal draws `undelivered`/`unanswered`
 * as alerts and shows the reason.
 */

function decisionRecord(outcome: string, reason?: string): JournalRecord {
  return {
    id: '01J0000000000000000000000D',
    ts: '2026-10-09T08:00:00.000Z',
    sessionId: 'sess',
    direction: 'client→server',
    kind: 'decision',
    payload: null,
    decision: {
      outcome: outcome as never,
      rule: 'session-ended',
      serverName: 'probe',
      toolName: 'slow_echo',
      toolClass: 'read',
      quarantineState: 'known',
      argsHash: 'hash',
      ...(reason !== undefined ? { reason } : {}),
    },
  }
}

describe('mcpcut show: phase C records', () => {
  test('the reason is printed, and a record without arguments ends at the summary', () => {
    const line = formatRecordsReadable([decisionRecord('unanswered', 'disconnected')])

    expect(line).toContain('outcome=unanswered tool=slow_echo rule=session-ended reason=disconnected\n')
    expect(line).not.toContain('null')
  })

  test('a record without a reason prints none', () => {
    expect(formatRecordsReadable([decisionRecord('allow')])).not.toContain('reason=')
  })
})

describe('web journal: phase C records', () => {
  test('unanswered and undelivered are alerts, and the reason is shown', () => {
    for (const outcome of ['unanswered', 'undelivered']) {
      const row = String(renderRecordRow(decisionRecord(outcome, 'AbortError: user-cancel'), { withSession: false }))
      expect(row).toContain('pill-alert')
      expect(row).toContain('reason: AbortError: user-cancel')
    }
  })

  test('a replayed answer is not an alert', () => {
    expect(String(renderRecordRow(decisionRecord('replayed'), { withSession: false }))).not.toContain('pill-alert')
  })
})
