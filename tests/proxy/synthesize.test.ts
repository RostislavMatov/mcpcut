import { describe, expect, test } from 'vitest'
import {
  ERROR_CODE_APPROVAL,
  ERROR_CODE_POLICY_DENIED,
  ERROR_CODE_QUARANTINED,
  approvalDeniedError,
  approvalTimeoutError,
  denialError,
  quarantinedError,
  synthesizeError,
} from '../../src/proxy/synthesize.js'

/** Parses a synthesized error buffer, asserting the single-line + trailing-newline contract. */
function parseLine(bytes: Buffer): Record<string, unknown> {
  const text = bytes.toString('utf8')
  const lines = text.split('\n')
  expect(lines).toHaveLength(2)
  expect(lines[1]).toBe('')
  return JSON.parse(lines[0] as string) as Record<string, unknown>
}

function errorOf(bytes: Buffer): Record<string, unknown> {
  return parseLine(bytes)['error'] as Record<string, unknown>
}

describe('synthesizeError', () => {
  test('produces a valid JSON-RPC 2.0 error response terminated with a newline', () => {
    const bytes = synthesizeError('req-1', { code: -32001, message: 'blocked' })
    const parsed = parseLine(bytes)

    expect(parsed['jsonrpc']).toBe('2.0')
    expect(parsed['id']).toBe('req-1')
    expect(parsed['error']).toMatchObject({ code: -32001, message: 'blocked' })
  })

  test('preserves a numeric id, including 0', () => {
    const bytes = synthesizeError(0, { code: -32001, message: 'blocked' })

    expect(parseLine(bytes)['id']).toBe(0)
  })

  test('preserves a string id', () => {
    const bytes = synthesizeError('abc-123', { code: -32001, message: 'blocked' })

    expect(parseLine(bytes)['id']).toBe('abc-123')
  })

  test('includes optional machine-readable data', () => {
    const bytes = synthesizeError('req-1', {
      code: -32001,
      message: 'blocked',
      data: { reason: 'policy_denied', toolName: 'delete_file' },
    })

    expect(errorOf(bytes)).toMatchObject({
      data: { reason: 'policy_denied', toolName: 'delete_file' },
    })
  })

  test('omits data entirely when not provided', () => {
    const bytes = synthesizeError('req-1', { code: -32001, message: 'blocked' })

    expect('data' in errorOf(bytes)).toBe(false)
  })

  test('stays single-line even when the message contains embedded newlines and control characters', () => {
    const hostileMessage = 'line one\nline two\x1b[31mred\x1b[0m\ttab\rcarriage'
    const bytes = synthesizeError('req-1', { code: -32001, message: hostileMessage })
    const text = bytes.toString('utf8')

    // Exactly one literal newline in the whole buffer: the trailing terminator.
    expect(text.split('\n')).toHaveLength(2)
    expect(text.endsWith('\n')).toBe(true)
    expect(errorOf(bytes)['message']).toBe(hostileMessage)
  })
})

describe('error code constants', () => {
  test('are distinct, in the -320xx reserved implementation-defined range', () => {
    expect(ERROR_CODE_POLICY_DENIED).toBe(-32001)
    expect(ERROR_CODE_APPROVAL).toBe(-32002)
    expect(ERROR_CODE_QUARANTINED).toBe(-32003)
  })
})

describe('denialError', () => {
  test('uses the policy-denied error code', () => {
    const bytes = denialError('req-1', { toolName: 'delete_file', rule: 'no-destructive-writes' })

    expect(errorOf(bytes)['code']).toBe(ERROR_CODE_POLICY_DENIED)
  })

  test('message names the tool and rule, and tells the agent a human can change the policy', () => {
    const bytes = denialError('req-1', { toolName: 'delete_file', rule: 'no-destructive-writes' })
    const message = errorOf(bytes)['message'] as string

    expect(message).toContain('delete_file')
    expect(message).toContain('no-destructive-writes')
    expect(message.toLowerCase()).toContain('human')
  })

  test('data carries the machine-readable reason, tool name, and rule', () => {
    const bytes = denialError('req-1', { toolName: 'delete_file', rule: 'no-destructive-writes' })

    expect(errorOf(bytes)['data']).toMatchObject({
      reason: 'policy_denied',
      toolName: 'delete_file',
      rule: 'no-destructive-writes',
    })
  })
})

describe('approvalTimeoutError', () => {
  test('uses the approval error code', () => {
    const bytes = approvalTimeoutError('req-2', { toolName: 'send_email', approvalId: 'appr-42' })

    expect(errorOf(bytes)['code']).toBe(ERROR_CODE_APPROVAL)
  })

  test('message is actionable: names the CLI approve command with the approval id and tells the agent to retry', () => {
    const bytes = approvalTimeoutError('req-2', { toolName: 'send_email', approvalId: 'appr-42' })
    const message = errorOf(bytes)['message'] as string

    expect(message).toContain('mcp-journal approvals approve appr-42')
    expect(message).toContain('send_email')
    expect(message.toLowerCase()).toContain('retry')
  })

  test('data carries the machine-readable reason, tool name, and approval id', () => {
    const bytes = approvalTimeoutError('req-2', { toolName: 'send_email', approvalId: 'appr-42' })

    expect(errorOf(bytes)['data']).toMatchObject({
      reason: 'approval_timeout',
      toolName: 'send_email',
      approvalId: 'appr-42',
    })
  })
})

describe('approvalDeniedError', () => {
  test('uses the approval error code', () => {
    const bytes = approvalDeniedError('req-3', { toolName: 'send_email' })

    expect(errorOf(bytes)['code']).toBe(ERROR_CODE_APPROVAL)
  })

  test('message names the tool and states a human denied it', () => {
    const bytes = approvalDeniedError('req-3', { toolName: 'send_email' })
    const message = errorOf(bytes)['message'] as string

    expect(message).toContain('send_email')
    expect(message.toLowerCase()).toContain('denied')
  })

  test('data carries the machine-readable reason and tool name', () => {
    const bytes = approvalDeniedError('req-3', { toolName: 'send_email' })

    expect(errorOf(bytes)['data']).toMatchObject({ reason: 'approval_denied', toolName: 'send_email' })
  })
})

describe('quarantinedError', () => {
  test('uses the quarantined error code', () => {
    const bytes = quarantinedError('req-4', { toolName: 'new_tool', serverName: 'billing' })

    expect(errorOf(bytes)['code']).toBe(ERROR_CODE_QUARANTINED)
  })

  test('message is actionable: names the CLI quarantine-approve command with server and tool', () => {
    const bytes = quarantinedError('req-4', { toolName: 'new_tool', serverName: 'billing' })
    const message = errorOf(bytes)['message'] as string

    expect(message).toContain('mcp-journal quarantine approve billing new_tool')
    expect(message.toLowerCase()).toContain('quarantine')
  })

  test('data carries the machine-readable reason, tool name, and server name', () => {
    const bytes = quarantinedError('req-4', { toolName: 'new_tool', serverName: 'billing' })

    expect(errorOf(bytes)['data']).toMatchObject({
      reason: 'quarantined',
      toolName: 'new_tool',
      serverName: 'billing',
    })
  })
})
