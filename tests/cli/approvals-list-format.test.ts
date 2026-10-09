import { describe, expect, test } from 'vitest'
import { formatListReadable } from '../../src/cli/approvals-list-format.js'
import type { PendingApproval } from '../../src/policy/approvals/queue.js'

const T0 = Date.parse('2026-10-09T08:00:00.000Z')

function pending(overrides: Partial<PendingApproval>): PendingApproval {
  return {
    approvalId: '01J0000000000000000000000C',
    serverName: 'fs',
    toolName: 'write_file',
    toolClass: 'write',
    argsRedacted: {},
    argsHash: 'hash',
    sessionId: 'sess',
    requestedAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 86_400_000).toISOString(),
    expired: false,
    ...overrides,
  }
}

describe('approvals list: whether anyone still waits for the call (M36)', () => {
  test('a silent holder says since when, so the operator knows an approval would send nothing', () => {
    const line = formatListReadable([pending({ agentConnected: false, holderSeenAt: '2026-10-09T07:58:00.000Z' })], T0 + 5_000)

    expect(line).toContain('agent_connected=no silent_since=2026-10-09T07:58:00.000Z ')
  })

  test('a connected holder is just yes', () => {
    expect(formatListReadable([pending({ agentConnected: true })], T0)).toContain('agent_connected=yes ')
  })

  test('a resend of a call whose first request closed says when', () => {
    const line = formatListReadable([pending({ agentConnected: true, resendOfWithdrawnAt: '2026-10-09T07:59:00.000Z' })], T0)

    expect(line).toContain('agent_connected=yes resend_of_withdrawn=2026-10-09T07:59:00.000Z args=')
  })
})
