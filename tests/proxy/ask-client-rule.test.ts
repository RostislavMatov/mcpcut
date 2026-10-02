import { describe, expect, test } from 'vitest'
import type { PolicyProvider } from '../../src/policy/reload.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { askClientDepsOf, type AskClientWiring } from '../../src/proxy/ask-client-rule.js'
import type { ApprovalQuestion } from '../../src/proxy/client-approval.js'

/**
 * Who may be asked in the client (ADR-0019): a tool the policy lists in
 * `approveInClient` always — on an agent's path and with admins too; any
 * other held tool only where the entry point allows it (`wrap` without
 * admins); nobody with `approval.askClient: false`.
 */

function policyOf(extra: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({ version: 1, ...extra })
  if (!result.ok) throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

const LISTED = { servers: { fs: { tools: { write_file: 'require-approval' }, approveInClient: ['write_file', 'github_*'] } } }

const question = (toolName: string, approvalId = 'A1'): ApprovalQuestion => ({ approvalId, toolName, serverName: 'fs', args: {} })

interface Recorded {
  readonly resolved: string[]
  readonly notices: string[]
}

function depsOf(policy: Policy | PolicyProvider, wiring: Partial<AskClientWiring> | undefined, rec: Recorded = { resolved: [], notices: [] }) {
  const queue = {
    resolve: async (approvalId: string): Promise<{ ok: false; reason: 'not-found-or-already-resolved' }> => {
      rec.resolved.push(approvalId)
      return { ok: false, reason: 'not-found-or-already-resolved' }
    },
  }
  const full = wiring === undefined ? undefined : { command: 'mcpcut', onNotice: (text: string) => rec.notices.push(text), ...wiring }
  return askClientDepsOf({ policy, serverName: 'fs' }, full, queue).askClient
}

describe('askClientDepsOf: who is asked', () => {
  test('no wiring from the entry point (the HTTP front): nobody', () => {
    expect(depsOf(policyOf(LISTED), undefined)).toBeUndefined()
  })

  test('an agent\'s connect (no mayAskUnlisted): only the listed tools', async () => {
    const deps = depsOf(policyOf(LISTED), {})

    expect(await deps?.mayAsk?.(question('write_file'))).toBe(true)
    expect(await deps?.mayAsk?.(question('github_create_issue'))).toBe(true)
    expect(await deps?.mayAsk?.(question('delete_file'))).toBe(false)
  })

  test('wrap on an installation with admins: only the listed tools', async () => {
    const deps = depsOf(policyOf(LISTED), { mayAskUnlisted: () => Promise.resolve(false) })

    expect(await deps?.mayAsk?.(question('write_file'))).toBe(true)
    expect(await deps?.mayAsk?.(question('delete_file'))).toBe(false)
  })

  test('wrap with no admins: every held tool', async () => {
    const deps = depsOf(policyOf(), { mayAskUnlisted: () => Promise.resolve(true) })

    expect(await deps?.mayAsk?.(question('delete_file'))).toBe(true)
  })

  test('approval.askClient false: nobody, listed or not', async () => {
    const deps = depsOf(policyOf({ ...LISTED, approval: { askClient: false } }), { mayAskUnlisted: () => Promise.resolve(true) })

    expect(await deps?.mayAsk?.(question('write_file'))).toBe(false)
    expect(await deps?.mayAsk?.(question('delete_file'))).toBe(false)
  })

  test('the live policy decides: a tool listed after the session started is asked', async () => {
    let current = policyOf()
    const provider = { current: () => current, maybeRefresh: () => undefined } as unknown as PolicyProvider
    const deps = depsOf(provider, {})

    expect(await deps?.mayAsk?.(question('write_file'))).toBe(false)
    current = policyOf(LISTED)
    expect(await deps?.mayAsk?.(question('write_file'))).toBe(true)
  })

  test('a listed tool on another server does not count', async () => {
    const deps = depsOf(policyOf({ servers: { other: { approveInClient: ['write_file'] } } }), {})

    expect(await deps?.mayAsk?.(question('write_file'))).toBe(false)
  })
})

describe('askClientDepsOf: the answer is checked again when it lands', () => {
  test('a listed tool: the answer goes to the queue, admins or not', async () => {
    const rec: Recorded = { resolved: [], notices: [] }
    const deps = depsOf(policyOf(LISTED), { mayAskUnlisted: () => Promise.resolve(false) }, rec)

    await deps?.resolve(question('write_file', 'A2'), { outcome: 'approved', actor: 'client:claude-code', reason: 'accepted in the client' })

    expect(rec.resolved).toEqual(['A2'])
  })

  test('an unlisted tool after an admin was added: nothing settled, the command named', async () => {
    const rec: Recorded = { resolved: [], notices: [] }
    const deps = depsOf(policyOf(), { mayAskUnlisted: () => Promise.resolve(false) }, rec)

    await deps?.resolve(question('delete_file', 'A3'), { outcome: 'approved', actor: 'client:claude-code', reason: 'accepted in the client' })

    expect(rec.resolved).toEqual([])
    expect(rec.notices.join('')).toContain('mcpcut approvals approve A3')
  })

  test('a failing installation check counts as no', async () => {
    const rec: Recorded = { resolved: [], notices: [] }
    const deps = depsOf(policyOf(), { mayAskUnlisted: () => Promise.reject(new Error('locked')) }, rec)

    await deps?.resolve(question('delete_file', 'A4'), { outcome: 'denied', actor: 'client:claude-code', reason: 'declined in the client' })

    expect(rec.resolved).toEqual([])
  })
})
