import { describe, expect, test } from 'vitest'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import type { GateAgentScope } from '../../src/proxy/gate.js'
import { askClientOf } from '../../src/proxy/wire-policy.js'

/**
 * Who may be asked (P2): only the person at a `wrap` client, only while the
 * policy allows it, and an answer counts only while the installation has no
 * admins — the same rule as `approvals approve` without a token.
 */

function policyOf(approval: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({ version: 1, approval })
  if (!result.ok) throw new Error('test policy is invalid')
  return result.policy
}

const resolved: string[] = []
const QUEUE = {
  resolve: async (approvalId: string): Promise<{ ok: false; reason: 'not-found-or-already-resolved' }> => {
    resolved.push(approvalId)
    return { ok: false, reason: 'not-found-or-already-resolved' }
  },
}

function wiring(mayAsk: boolean, notices: string[] = []): { mayAsk: () => Promise<boolean>; command: string; onNotice: (text: string) => void } {
  return { mayAsk: () => Promise.resolve(mayAsk), command: 'npx -y mcpcut@9.9.9', onNotice: (text) => notices.push(text) }
}

describe('askClientOf', () => {
  test('wrap with the default policy: the gate gets an asker', () => {
    expect(askClientOf({ policy: policyOf(), askClient: wiring(true) }, QUEUE).askClient).toBeDefined()
  })

  test('connect (an agent with an identity): never — the person at that client is an agent user, not an approver', () => {
    const agentScope = { agentName: 'bot' } as unknown as GateAgentScope

    expect(askClientOf({ policy: policyOf(), askClient: wiring(true), agentScope }, QUEUE)).toEqual({})
  })

  test('approval.askClient false: never', () => {
    expect(askClientOf({ policy: policyOf({ askClient: false }), askClient: wiring(true) }, QUEUE)).toEqual({})
  })

  test('no wiring from the entry point: never', () => {
    expect(askClientOf({ policy: policyOf() }, QUEUE)).toEqual({})
  })

  test('an answer landing after an admin was added does not settle anything, and says how to approve', async () => {
    const notices: string[] = []
    const deps = askClientOf({ policy: policyOf(), askClient: wiring(false, notices) }, QUEUE).askClient

    await deps?.resolve('A9', { outcome: 'approved', actor: 'client:claude-code', reason: 'accepted in the client' })

    expect(resolved).not.toContain('A9')
    expect(notices.join('')).toContain('npx -y mcpcut@9.9.9 approvals approve A9')
  })

  test('with no admins, the answer goes to the queue', async () => {
    const deps = askClientOf({ policy: policyOf(), askClient: wiring(true) }, QUEUE).askClient

    await deps?.resolve('A10', { outcome: 'denied', actor: 'client:claude-code', reason: 'declined in the client' })

    expect(resolved).toContain('A10')
  })

  test('a failing admin check counts as admins: nothing is settled, and the command is named', async () => {
    const notices: string[] = []
    const failing = { mayAsk: () => Promise.reject(new Error('locked')), command: 'mcpcut', onNotice: (text: string) => notices.push(text) }
    const deps = askClientOf({ policy: policyOf(), askClient: failing }, QUEUE).askClient

    await deps?.resolve('A11', { outcome: 'approved', actor: 'client:claude-code', reason: 'accepted in the client' })

    expect(resolved).not.toContain('A11')
    expect(notices.join('')).toContain('mcpcut approvals approve A11')
  })
})
