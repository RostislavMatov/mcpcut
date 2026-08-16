import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { APPROVALS_LIST_MAX_ROWS } from '../../src/config.js'
import {
  createApprovalQueue,
  type ApprovalQueue,
  type PendingApproval,
} from '../../src/policy/approvals/queue.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'
import type { UiSession } from '../../src/ui/auth.js'
import { createApprovalsHandlers, type ApprovalsQueue } from '../../src/ui/handlers/approvals.js'
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
  queue = createApprovalQueue({ baseDir: join(dir, 'approvals'), clock: () => now })
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

/**
 * A synthetic `list()` row, for tests that need to simulate a raw queue read
 * shape (a bound hit, or malformed rows already dropped) without paying for
 * hundreds of real sqlite writes through `enqueueSample()`.
 */
function syntheticPending(approvalId: string, requestedAtMs: number): PendingApproval {
  return {
    approvalId,
    serverName: 'github',
    toolName: 'create_issue',
    toolClass: 'write',
    argsRedacted: {},
    argsHash: 'hash',
    sessionId: 'sess-1',
    requestedAt: new Date(requestedAtMs).toISOString(),
    expiresAt: new Date(requestedAtMs + GRANT_MS).toISOString(),
    expired: false,
  }
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

describe('approval id validation at the handler boundary (LOW-2)', () => {
  test('a malformed id is a 400 and never reaches the queue', async () => {
    const handlers = createApprovalsHandlers({ queue, clock: () => now })
    const seen: string[] = []
    const spying = createApprovalsHandlers({
      queue: {
        list: () => queue.list(),
        countPending: () => queue.countPending(),
        resolve: (id, options) => {
          seen.push(id)
          return queue.resolve(id, options)
        },
      },
      clock: () => now,
    })

    for (const id of ['../../etc/passwd', 'a'.repeat(65), 'has space', 'semi;colon']) {
      const result = await spying.approvalsApprove(makeCtx({ method: 'POST', params: { id } }))
      if (result.kind === 'response') expect(result.status, id).toBe(400)
      expect(bodyText(result)).toMatch(/invalid approval id/i)
    }
    expect(seen).toEqual([])

    // A well-formed (if unknown) id is still the queue's business to answer.
    const unknown = await handlers.approvalsApprove(
      makeCtx({ method: 'POST', params: { id: '01J0000000000000000000000A' } }),
    )
    if (unknown.kind === 'response') expect(unknown.status).toBe(409)
  })
})

describe('a bounded read never reads as a drained queue', () => {
  /**
   * Truncation must be a property of THIS read hitting its own row bound
   * (`APPROVALS_LIST_MAX_ROWS`), never a bare comparison of `cards.length` to
   * `totalPending` — the identical mistake shipped in the CLI (`approvals-cmd.ts`
   * `runList`, fixed in commit f05c6d2) and broke a polling consumer
   * non-deterministically: `list()` and `countPending()` are separate
   * transactions, so a request committing between them made
   * `totalPending > cards.length` true on a queue nowhere near truncated.
   * The UI has its own second way to trip the same bare comparison: `list()`
   * drops rows that fail to parse (`parseDoc`), so `cards.length` can be BELOW
   * the bound even when nothing beyond the bound was missed.
   */
  test('a read below the bound with a larger totalPending (the race) is not truncation', async () => {
    // Simulates a second approval committing after `list()` already returned
    // but before `countPending()` runs — the exact race the two-read
    // aggregation in `loadCards` cannot itself prevent.
    let totalPending = 1
    const raceQueue: ApprovalsQueue = {
      list: async () => {
        const result = [syntheticPending('01J0000000000000000000001', now)]
        totalPending = 2
        return result
      },
      countPending: async () => totalPending,
      resolve: (id, options) => queue.resolve(id, options),
    }
    const handlers = createApprovalsHandlers({ queue: raceQueue, clock: () => now })

    const body = bodyText(await handlers.approvalsPage(makeCtx({})))

    expect(body).toContain('1 pending')
    expect(body).not.toContain('showing the oldest')
    expect(body).toContain('data-pending-count="1"')
    expect(body).not.toContain('data-pending-total')
  })

  test('malformed rows dropped from an unbounded read are not truncation', async () => {
    // `list()` fetched everything there was to fetch (well under the bound);
    // `countPending()` counts rows by status regardless of whether their JSON
    // parses, so a queue with unparseable rows legitimately reports a higher
    // total than the parsed, rendered card count — that gap is not a hidden
    // backlog, it is unrenderable content, and the current behaviour (silently
    // showing "2 pending") is itself imperfect: an operator has no signal that
    // rows exist beyond what a bound could ever have hidden. Closing that gap
    // honestly needs the queue to report a drop count, which is out of scope
    // here (see report) — this test only pins that it must NOT be misreported
    // as a truncated (bound-hit) read.
    const malformedQueue: ApprovalsQueue = {
      list: async () => [
        syntheticPending('01J0000000000000000000001', now),
        syntheticPending('01J0000000000000000000002', now),
      ],
      countPending: async () => 5,
      resolve: (id, options) => queue.resolve(id, options),
    }
    const handlers = createApprovalsHandlers({ queue: malformedQueue, clock: () => now })

    const body = bodyText(await handlers.approvalsPage(makeCtx({})))

    expect(body).toContain('2 pending')
    expect(body).not.toContain('showing the oldest')
    expect(body).toContain('data-pending-count="2"')
    expect(body).not.toContain('data-pending-total')
  })

  test('a read that hits its own bound still reads as truncated, with the right numbers', async () => {
    const cards = Array.from({ length: APPROVALS_LIST_MAX_ROWS }, (_unused, index) =>
      syntheticPending(`01J${String(index).padStart(23, '0')}`, now),
    )
    const boundedQueue: ApprovalsQueue = {
      list: async () => cards,
      countPending: async () => APPROVALS_LIST_MAX_ROWS + 5,
      resolve: (id, options) => queue.resolve(id, options),
    }
    const handlers = createApprovalsHandlers({ queue: boundedQueue, clock: () => now })

    const result = await handlers.approvalsPage(makeCtx({}))

    // Showing only the bound on a bigger queue would tell an operator the
    // backlog is drained when it is not.
    const body = bodyText(result)
    expect(body).toContain(`${APPROVALS_LIST_MAX_ROWS} of ${APPROVALS_LIST_MAX_ROWS + 5} pending`)
    expect(body).toContain('showing the oldest')
    // …and the tab badge must not contradict that line: the client script
    // builds it from these attributes, so the true total has to travel with
    // them or a glance at the tab reads the backlog as drained to the bound.
    expect(body).toContain(`data-pending-count="${APPROVALS_LIST_MAX_ROWS}"`)
    expect(body).toContain(`data-pending-total="${APPROVALS_LIST_MAX_ROWS + 5}"`)
  })

  test('an untruncated read says nothing about truncation', async () => {
    const handlers = createApprovalsHandlers({ queue, clock: () => now })
    await enqueueSample()

    const body = bodyText(await handlers.approvalsPage(makeCtx({})))

    expect(body).toContain('1 pending')
    expect(body).not.toContain('showing the oldest')
    // No truncation, no override: the badge stays the plain pending count.
    expect(body).toContain('data-pending-count="1"')
    expect(body).not.toContain('data-pending-total')
  })

  test('an empty queue is unchanged: no cards, no truncation', async () => {
    const handlers = createApprovalsHandlers({ queue, clock: () => now })

    const body = bodyText(await handlers.approvalsPage(makeCtx({})))

    expect(body).toContain('No pending approvals.')
    expect(body).toContain('0 pending')
    expect(body).not.toContain('showing the oldest')
    expect(body).toContain('data-pending-count="0"')
    expect(body).not.toContain('data-pending-total')
  })

  test('the JSON API carries the total and the truncated flag beside the bounded array', async () => {
    const cards = Array.from({ length: APPROVALS_LIST_MAX_ROWS }, (_unused, index) =>
      syntheticPending(`01J${String(index).padStart(23, '0')}`, now),
    )
    const boundedQueue: ApprovalsQueue = {
      list: async () => cards,
      countPending: async () => APPROVALS_LIST_MAX_ROWS + 5,
      resolve: (id, options) => queue.resolve(id, options),
    }
    const handlers = createApprovalsHandlers({ queue: boundedQueue, clock: () => now })

    const payload = JSON.parse(bodyText(await handlers.approvalsApi(makeCtx({})))) as {
      approvals: unknown[]
      totalPending: number
      truncated: boolean
    }

    expect(payload.approvals).toHaveLength(APPROVALS_LIST_MAX_ROWS)
    expect(payload.totalPending).toBe(APPROVALS_LIST_MAX_ROWS + 5)
    expect(payload.truncated).toBe(true)
  })

  test('the JSON API does not claim truncation for a read below the bound', async () => {
    const handlers = createApprovalsHandlers({
      queue: {
        list: () => queue.list({ limit: 1 }),
        countPending: () => queue.countPending(),
        resolve: (id, options) => queue.resolve(id, options),
      },
      clock: () => now,
    })
    for (let i = 0; i < 3; i += 1) await enqueueSample()

    const payload = JSON.parse(bodyText(await handlers.approvalsApi(makeCtx({})))) as {
      approvals: unknown[]
      totalPending: number
      truncated: boolean
    }

    expect(payload.approvals).toHaveLength(1)
    expect(payload.totalPending).toBe(3)
    expect(payload.truncated).toBe(false)
  })
})
