import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createApprovalQueue, type ApprovalQueue } from '../../src/policy/approvals/queue.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'
import type { UiSession } from '../../src/ui/auth.js'
import { createApprovalsHandlers } from '../../src/ui/handlers/approvals.js'
import { eligibleForBatch, type ApprovalCardView } from '../../src/ui/pages/approvals.js'

/**
 * Task 12 — approvals queue page + approve/deny actions. Uses a REAL
 * file-backed queue so the attribution written to the resolved file is
 * observed, not mocked; rendering is asserted against the escaping `html`
 * output.
 */

const OPERATOR: UiSession = { adminName: 'alice', role: 'operator', csrfToken: 'csrf-token-value-123456' }
const T0 = Date.parse('2026-08-11T12:00:00.000Z')
const GRANT_MS = 5 * 60 * 1000
const WAIT_MS = 60 * 1000

let dir: string
let queue: ApprovalQueue
let now: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-ui-approvals-'))
  now = T0
  queue = createApprovalQueue({ baseDir: dir, clock: () => now })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeCtx(overrides: Partial<UiRequestContext> = {}): UiRequestContext {
  return {
    method: 'GET',
    path: '/',
    params: {},
    query: new URLSearchParams(),
    session: OPERATOR,
    body: Buffer.alloc(0),
    headers: {},
    ...overrides,
  }
}

async function enqueueSample(over: Partial<Parameters<ApprovalQueue['enqueue']>[0]> = {}): Promise<string> {
  const { approvalId } = await queue.enqueue({
    serverName: 'github',
    toolName: 'create_issue',
    toolClass: 'write',
    args: { title: 'hello', token: 'secret-value' },
    sessionId: 'sess-1',
    timeoutMs: GRANT_MS,
    waitTimeoutMs: WAIT_MS,
    agentName: 'research-bot',
    decisionRule: 'require-approval:write',
    ...over,
  })
  return approvalId
}

function bodyText(result: UiResult): string {
  if (result.kind !== 'response') throw new Error('expected a response result')
  const body = result.body ?? ''
  return typeof body === 'string' ? body : body.toString('utf8')
}

describe('approvalsPage rendering', () => {
  test('shows agent, server, tool, class, redacted args and wait remaining separate from grant window', async () => {
    await enqueueSample()
    const handlers = createApprovalsHandlers({ queue, clock: () => T0 + 18_000 })
    const result = await handlers.approvalsPage(makeCtx())
    const html = bodyText(result)

    expect(html).toContain('research-bot')
    expect(html).toContain('github')
    expect(html).toContain('create_issue')
    expect(html).toContain('write')
    // Secret argument value must have been redacted before it reached the page.
    expect(html).not.toContain('secret-value')
    // Agent wait remaining (60s window, 18s elapsed → 42s) shown distinctly.
    expect(html).toContain('42')
    // Grant window remaining (300s window, 18s elapsed → 282s) shown too.
    expect(html).toContain('282')
  })

  test('escapes hostile tool name and arguments from a malicious server', async () => {
    await enqueueSample({
      toolName: '<script>alert(1)</script>',
      args: { note: '<img src=x onerror=alert(2)>' },
    })
    const handlers = createApprovalsHandlers({ queue, clock: () => T0 })
    const html = bodyText(await handlers.approvalsPage(makeCtx()))

    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<img src=x onerror=alert(2)>')
  })

  test('every action form embeds the session csrf_token', async () => {
    await enqueueSample()
    const handlers = createApprovalsHandlers({ queue, clock: () => T0 })
    const html = bodyText(await handlers.approvalsPage(makeCtx()))
    expect(html).toContain('name="csrf_token"')
    expect(html).toContain('csrf-token-value-123456')
  })
})

describe('eligibleForBatch', () => {
  test('read-class approvals are batch-eligible, write and destructive are not', () => {
    const read: ApprovalCardView = { toolClass: 'read' } as ApprovalCardView
    const write: ApprovalCardView = { toolClass: 'write' } as ApprovalCardView
    const destructive: ApprovalCardView = { toolClass: 'destructive' } as ApprovalCardView
    expect(eligibleForBatch(read)).toBe(true)
    expect(eligibleForBatch(write)).toBe(false)
    expect(eligibleForBatch(destructive)).toBe(false)
  })

  test('a write-only queue renders no bulk-approve control', async () => {
    await enqueueSample({ toolClass: 'write' })
    const handlers = createApprovalsHandlers({ queue, clock: () => T0 })
    const html = bodyText(await handlers.approvalsPage(makeCtx()))
    expect(html).not.toContain('data-bulk-approve')
  })
})

describe('approvalsApi', () => {
  test('returns pending approvals as JSON for the SSE fallback', async () => {
    await enqueueSample()
    const handlers = createApprovalsHandlers({ queue, clock: () => T0 })
    const result = await handlers.approvalsApi(makeCtx({ path: '/api/approvals' }))
    if (result.kind !== 'response') throw new Error('expected response')
    expect(result.body).toBeInstanceOf(Buffer)
    const parsed = JSON.parse(bodyText(result)) as { approvals: ApprovalCardView[] }
    expect(parsed.approvals).toHaveLength(1)
    expect(parsed.approvals[0]?.toolName).toBe('create_issue')
  })
})

describe('approvalsApprove attribution', () => {
  test('approve records queue.resolve with actor ui:<adminName> visible in the resolved file', async () => {
    const id = await enqueueSample()
    const handlers = createApprovalsHandlers({ queue, clock: () => T0 + 1000 })
    const result = await handlers.approvalsApprove(makeCtx({ method: 'POST', params: { id } }))
    if (result.kind !== 'response') throw new Error('expected response')
    expect(result.status).toBe(200)

    const resolution = await queue.readResolution(id)
    expect(resolution?.outcome).toBe('approved')
    expect(resolution?.actor).toBe('ui:alice')
    expect(resolution?.actor).toContain('alice')
  })

  test('deny records outcome denied with the deciding admin', async () => {
    const id = await enqueueSample()
    const handlers = createApprovalsHandlers({ queue, clock: () => T0 + 1000 })
    const result = await handlers.approvalsDeny(makeCtx({ method: 'POST', params: { id } }))
    if (result.kind !== 'response') throw new Error('expected response')
    expect(result.status).toBe(200)
    const resolution = await queue.readResolution(id)
    expect(resolution?.outcome).toBe('denied')
    expect(resolution?.actor).toBe('ui:alice')
  })

  test('a second approve of the same id is a readable "already resolved", not a 500', async () => {
    const id = await enqueueSample()
    const handlers = createApprovalsHandlers({ queue, clock: () => T0 + 1000 })
    await handlers.approvalsApprove(makeCtx({ method: 'POST', params: { id } }))
    const second = await handlers.approvalsApprove(makeCtx({ method: 'POST', params: { id } }))
    if (second.kind !== 'response') throw new Error('expected response')
    expect(second.status).not.toBe(500)
    expect(bodyText(second).toLowerCase()).toContain('already')
  })

  test('approving an id the CLI resolved a moment earlier returns the same first-resolve-wins response', async () => {
    const id = await enqueueSample()
    // The CLI wins the race first.
    now = T0 + 500
    await queue.resolve(id, { outcome: 'approved', actor: 'cli:carol' })

    const handlers = createApprovalsHandlers({ queue, clock: () => T0 + 1000 })
    const uiResult = await handlers.approvalsApprove(makeCtx({ method: 'POST', params: { id } }))
    if (uiResult.kind !== 'response') throw new Error('expected response')
    expect(uiResult.status).not.toBe(500)
    expect(bodyText(uiResult).toLowerCase()).toContain('already')

    // The first (CLI) resolution is the surviving one.
    const resolution = await queue.readResolution(id)
    expect(resolution?.actor).toBe('cli:carol')
  })

  test('a missing admin session fails closed rather than mutating', async () => {
    const id = await enqueueSample()
    const handlers = createApprovalsHandlers({ queue, clock: () => T0 + 1000 })
    const result = await handlers.approvalsApprove(makeCtx({ method: 'POST', params: { id }, session: undefined }))
    if (result.kind !== 'response') throw new Error('expected response')
    expect(result.status).toBe(403)
    expect(await queue.readResolution(id)).toBeNull()
  })
})
