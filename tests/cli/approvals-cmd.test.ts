import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { APPROVAL_RESOLVE_MIN_ROLE, roleSatisfies } from '../../src/admin/authz.js'
import { ADMIN_TOKEN_ENV_VAR, ADMINS_FILE_NAME, type AdminRole } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { ROUTE_TABLE } from '../../src/ui/authz.js'
import { APPROVALS_LIST_MAX_ROWS } from '../../src/config.js'
import { DEFAULT_GRANT_TTL_MS } from '../../src/policy/constants.js'
import {
  createApprovalQueue,
  type ApprovalQueue,
  type EnqueueRequest,
  type PendingApproval,
} from '../../src/policy/approvals/queue.js'
import { runApprovals, type ApprovalsCliOptions } from '../../src/cli/approvals-cmd.js'

let tempDir: string
let baseDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-approvals-cmd-test-'))
  baseDir = join(tempDir, 'approvals')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

/** Captures stdout/stderr writes for assertions instead of touching the real streams. */
function fakeIo(): { stdout: { write: (chunk: string) => void }; stderr: { write: (chunk: string) => void }; out: () => string; err: () => string } {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

const SECRET_MARKER = 'sk-live-abcdefghijklmnopqrstuvwx'

function baseRequest(overrides: Partial<EnqueueRequest> = {}): EnqueueRequest {
  return {
    serverName: 'github',
    toolName: 'create_issue',
    toolClass: 'write',
    args: { title: 'hello', apiKey: SECRET_MARKER },
    sessionId: 'session-1',
    timeoutMs: 60_000,
    ...overrides,
  }
}

/**
 * Options for a run that carries NO admin token. Every test builds its options
 * with an explicit `env`, so the suite can never pass (or fail) because the
 * developer running it happens to have `MCP_ADMIN_TOKEN` exported.
 */
function anonymousOpts(): ApprovalsCliOptions {
  return { baseDir, journalDir: tempDir, env: {} }
}

/** Options for a run carrying `token` as the personal admin token. */
function optsWithToken(token: string): ApprovalsCliOptions {
  return { baseDir, journalDir: tempDir, env: { [ADMIN_TOKEN_ENV_VAR]: token } }
}

/**
 * Creates a real admin in this test's journal directory (real store, real
 * SQLite — the token hash comparison under test is the production one) and
 * returns its one-time token together with ready-made CLI options.
 */
async function createAdminToken(
  name: string,
  role: AdminRole = 'operator',
): Promise<{ readonly token: string; readonly opts: ApprovalsCliOptions }> {
  const { token } = await createAdminStore({ journalDir: tempDir }).createAdmin(name, role)
  return { token, opts: optsWithToken(token) }
}

/**
 * Minimal fake satisfying `ApprovalQueue`, for exercising the truncation path
 * without seeding hundreds of real rows through the on-disk queue. Only
 * `list`/`countPending` are exercised by the `list` subcommand; every other
 * member throws if a test path reaches it unexpectedly.
 */
function fakeQueue(entries: PendingApproval[], totalPending: number): ApprovalQueue {
  const notImplemented = (method: string) => (): never => {
    throw new Error(`fakeQueue.${method} should not be called by this test`)
  }
  return {
    enqueue: notImplemented('enqueue'),
    list: async () => entries,
    countPending: async () => totalPending,
    resolve: notImplemented('resolve'),
    markExpired: notImplemented('markExpired'),
    readResolution: notImplemented('readResolution'),
    listResolved: notImplemented('listResolved'),
    changesSince: notImplemented('changesSince'),
  }
}

function fakePendingEntry(index: number): PendingApproval {
  return {
    approvalId: `01ARZ3NDEKTSV4RRFFQ69G5FA${String(index).padStart(2, '0')}`,
    serverName: 'github',
    toolName: 'create_issue',
    toolClass: 'write',
    argsRedacted: { title: `entry-${index}` },
    argsHash: 'hash',
    sessionId: 'session-1',
    requestedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:05:00.000Z',
    expired: false,
  }
}

/**
 * A read that actually hit its bound. Truncation is derived from THIS, not from
 * `totalPending > entries.length`: `list()` and `countPending()` are separate
 * transactions, so a request committing between them once reported truncation
 * on a queue of one — which flipped the JSON shape and broke a consumer.
 */
function fakeBoundedPage(): PendingApproval[] {
  return Array.from({ length: APPROVALS_LIST_MAX_ROWS }, (_unused, index) => fakePendingEntry(index + 1))
}

describe('runApprovals: list, bounded-read truncation', () => {
  test('readable mode: a queue larger than the bound states what is shown vs. what exists', async () => {
    const queue = fakeQueue(fakeBoundedPage(), 900)
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, { baseDir, queue })

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out).toContain(`${APPROVALS_LIST_MAX_ROWS} of 900 pending`)
    expect(out).toContain('showing the oldest')
  })

  test('--json mode: a queue larger than the bound reports truncated alongside the bounded page', async () => {
    const entries = fakeBoundedPage()
    const queue = fakeQueue(entries, 900)
    const io = fakeIo()

    const exitCode = await runApprovals(['list', '--json'], io, { baseDir, queue })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(io.out())
    expect(parsed.truncated).toBe(true)
    expect(parsed.totalPending).toBe(900)
    expect(parsed.approvals).toHaveLength(APPROVALS_LIST_MAX_ROWS)
    expect(parsed.approvals[0].approvalId).toBe(entries[0]?.approvalId)
  })

  test('a short page is never truncated, even if countPending() raced ahead of list()', async () => {
    // The exact race that broke `policy-integration`: one entry listed, a
    // second request committed between the two reads.
    const queue = fakeQueue([fakePendingEntry(1)], 2)
    const io = fakeIo()

    const exitCode = await runApprovals(['list', '--json'], io, { baseDir, queue })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(io.out())
    expect(parsed.truncated).toBe(false)
    expect(parsed.approvals).toHaveLength(1)
  })

  test('readable mode: a queue at/under the bound prints no truncation note (pins existing behaviour)', async () => {
    const entries = [fakePendingEntry(1)]
    const queue = fakeQueue(entries, 1)
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, { baseDir, queue })

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out).not.toContain('showing the oldest')
    expect(out).not.toMatch(/\bof\b.*\bpending\b/)
  })

  test('--json mode: the envelope shape is the same whether or not the read was truncated', async () => {
    const queue = fakeQueue([fakePendingEntry(1)], 1)
    const io = fakeIo()

    const exitCode = await runApprovals(['list', '--json'], io, { baseDir, queue })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(io.out())
    expect(parsed).toEqual({
      truncated: false,
      totalPending: 1,
      approvals: [fakePendingEntry(1)],
    })
  })

  test('an empty queue is unchanged in both modes', async () => {
    const queue = fakeQueue([], 0)
    const readableIo = fakeIo()
    const jsonIo = fakeIo()

    const readableExit = await runApprovals(['list'], readableIo, { baseDir, queue })
    const jsonExit = await runApprovals(['list', '--json'], jsonIo, { baseDir, queue })

    expect(readableExit).toBe(0)
    expect(readableIo.out()).toBe('no pending approvals\n')
    expect(jsonExit).toBe(0)
    expect(JSON.parse(jsonIo.out())).toEqual({ truncated: false, totalPending: 0, approvals: [] })
  })
})

describe('runApprovals: list', () => {
  test('prints "no pending approvals" and returns 0 when the queue is empty', async () => {
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, { baseDir })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('no pending approvals')
  })

  test('lists pending entries with redacted args, hiding the raw secret', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, { baseDir })

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out).toContain(approvalId)
    expect(out).toContain('github')
    expect(out).toContain('create_issue')
    expect(out).toContain('write')
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain(SECRET_MARKER)
  })

  test('an entry whose expiresAt has passed is swept out of the queue, not listed as pending work', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    const { approvalId } = await queue.enqueue(baseRequest({ timeoutMs: 1000 }))
    nowMs += 5000
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, { baseDir, clock: () => nowMs })

    // `list()` sweeps at the injected clock (`policy/approvals/queue-sweep.ts`),
    // so a request nobody answered settles as `expired` instead of lingering as
    // a dead `expires_in=expired` line for the rest of the session's life.
    expect(exitCode).toBe(0)
    expect(io.out()).toContain('no pending approvals')
    expect(io.out()).not.toContain(approvalId)
    // Settled, not silently dropped: the outcome is the one session teardown writes.
    await expect(queue.readResolution(approvalId)).resolves.toMatchObject({ outcome: 'expired' })
  })

  test('an unexpired entry shows remaining time, not "expired"', async () => {
    let nowMs = Date.UTC(2026, 0, 1)
    const queue = createApprovalQueue({ baseDir, clock: () => nowMs })
    await queue.enqueue(baseRequest({ timeoutMs: 60_000 }))
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, { baseDir, clock: () => nowMs })

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out).not.toMatch(/\bexpired\b/)
  })

  test('--json prints parseable JSON describing the pending entries', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(['list', '--json'], io, { baseDir })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(io.out())
    expect(parsed.approvals).toHaveLength(1)
    expect(parsed.approvals[0].approvalId).toBe(approvalId)
    expect(parsed.approvals[0].argsRedacted.apiKey).toBe('[REDACTED]')
  })

  test('--json on an empty queue prints an empty, parseable envelope', async () => {
    const io = fakeIo()

    const exitCode = await runApprovals(['list', '--json'], io, { baseDir })

    expect(exitCode).toBe(0)
    expect(JSON.parse(io.out())).toEqual({ truncated: false, totalPending: 0, approvals: [] })
  })

  test('truncates a long redacted-args preview to roughly 200 characters', async () => {
    const queue = createApprovalQueue({ baseDir })
    const longValue = 'x'.repeat(500)
    await queue.enqueue(baseRequest({ args: { note: longValue } }))
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, { baseDir })

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out.length).toBeLessThan(600)
  })

  test('neutralizes control characters in toolName in the readable list output', async () => {
    const queue = createApprovalQueue({ baseDir })
    await queue.enqueue(baseRequest({ toolName: 'evil\x1b[2Jtool' }))
    const io = fakeIo()

    const exitCode = await runApprovals(['list'], io, { baseDir })

    expect(exitCode).toBe(0)
    const out = io.out()
    const withoutLineBreaks = out.replace(/\n/g, '')
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x1f\x7f]/.test(withoutLineBreaks)).toBe(false)
    expect(out).toContain('evil?[2Jtool')
  })
})

describe('runApprovals: approve', () => {
  test('approves a pending request, confirms the retry window and names the admin who did it', async () => {
    // REWRITTEN (M5 wave 2, task 2.6). This test used to assert
    // `resolution.actor === 'cli'` — a constant. That expectation was wrong,
    // not merely outdated: it made every human who ever approved anything from
    // a terminal indistinguishable from every other, so the queue recorded
    // THAT a destructive call was approved with no answer to BY WHOM. Waves
    // 3-4 hash-chain and sign these records and hand them to an auditor, which
    // would have frozen that anonymity into the evidence permanently.
    const { opts } = await createAdminToken('release-captain')
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', approvalId], io, opts)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain(approvalId)
    const expectedMinutes = String(Math.round(DEFAULT_GRANT_TTL_MS / 60_000))
    expect(io.out()).toContain(expectedMinutes)

    const resolution = await queue.readResolution(approvalId)
    expect(resolution?.outcome).toBe('approved')
    expect(resolution?.actor).toBe('cli:release-captain')
  })

  test('accepts --reason and persists it on the resolution', async () => {
    const { opts } = await createAdminToken('release-captain')
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', approvalId, '--reason', 'looks fine'], io, opts)

    expect(exitCode).toBe(0)
    const resolution = await queue.readResolution(approvalId)
    expect(resolution?.reason).toBe('looks fine')
  })

  test('approving the same id twice fails the second time with exit code 1', async () => {
    const { opts } = await createAdminToken('release-captain')
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const first = await runApprovals(['approve', approvalId], io, opts)
    const second = await runApprovals(['approve', approvalId], io, opts)

    expect(first).toBe(0)
    expect(second).toBe(1)
    expect(io.err()).toMatch(/already resolved or unknown id/)
  })

  test('approving an unknown id returns 1 with a clear message', async () => {
    const { opts } = await createAdminToken('release-captain')
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', '01ARZ3NDEKTSV4RRFFQ69G5FAV'], io, opts)

    expect(exitCode).toBe(1)
    expect(io.err()).toMatch(/already resolved or unknown id/)
  })

  test('missing <id> prints usage and returns 1', async () => {
    const { opts } = await createAdminToken('release-captain')
    const io = fakeIo()

    const exitCode = await runApprovals(['approve'], io, opts)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })
})

describe('runApprovals: deny', () => {
  test('denies a pending request', async () => {
    const { opts } = await createAdminToken('release-captain')
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(['deny', approvalId, '--reason', 'not authorized'], io, opts)

    expect(exitCode).toBe(0)
    const resolution = await queue.readResolution(approvalId)
    expect(resolution?.outcome).toBe('denied')
    expect(resolution?.reason).toBe('not authorized')
    expect(resolution?.actor).toBe('cli:release-captain')
  })

  test('denying an unknown id returns 1', async () => {
    const { opts } = await createAdminToken('release-captain')
    const io = fakeIo()

    const exitCode = await runApprovals(['deny', '01ARZ3NDEKTSV4RRFFQ69G5FAV'], io, opts)

    expect(exitCode).toBe(1)
  })
})

/**
 * Owner decision O3 (M5 wave 2, task 2.3): resolving an approval from the
 * shell requires a personal admin token, so the resolution can name the human.
 *
 * What this buys is ATTRIBUTION, not an access barrier — a process under the
 * same uid can read the environment anyway (the project's stated, accepted
 * threat model). These tests therefore pin WHO the record names and that a run
 * that cannot name anyone changes nothing at all, not that the token keeps
 * anybody out.
 */
describe('runApprovals: approve|deny require a personal admin token', () => {
  test('no token in the environment: exit 1 and the request is STILL pending', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', approvalId], io, anonymousOpts())

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(ADMIN_TOKEN_ENV_VAR)
    // Fail CLOSED: not merely a non-zero exit, but nothing written at all.
    // Resolving first and failing to attribute afterwards would be worse than
    // refusing, because the anonymous record would already be in the chain.
    expect(await queue.readResolution(approvalId)).toBeNull()
    expect((await queue.list()).map((entry) => entry.approvalId)).toContain(approvalId)
  })

  test('deny is gated the same way as approve', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(['deny', approvalId], io, anonymousOpts())

    expect(exitCode).toBe(1)
    expect(await queue.readResolution(approvalId)).toBeNull()
    expect((await queue.list()).map((entry) => entry.approvalId)).toContain(approvalId)
  })

  test('a token matching no admin: exit 1 and nothing is resolved', async () => {
    await createAdminToken('release-captain')
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(
      ['approve', approvalId],
      io,
      optsWithToken('mcpa_this-token-was-never-issued'),
    )

    expect(exitCode).toBe(1)
    expect(await queue.readResolution(approvalId)).toBeNull()
    expect((await queue.list()).map((entry) => entry.approvalId)).toContain(approvalId)
  })

  test('a REVOKED admin’s token behaves exactly like one that never existed', async () => {
    const store = createAdminStore({ journalDir: tempDir })
    await store.createAdmin('still-here', 'owner')
    const { token } = await store.createAdmin('gone-tomorrow', 'operator')
    await store.removeAdmin('gone-tomorrow')
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', approvalId], io, optsWithToken(token))

    expect(exitCode).toBe(1)
    expect(await queue.readResolution(approvalId)).toBeNull()
    expect((await queue.list()).map((entry) => entry.approvalId)).toContain(approvalId)
  })

  test('a corrupt admins file fails loudly with exit 1, and the request is STILL pending', async () => {
    // A hand-edited or truncated `admins.json` makes the admin store throw on
    // read. The operator must get the same exit-1 diagnostic the three other
    // refusal paths give, not a raw stack trace / unhandled rejection — and,
    // fail-closed, nothing may be resolved on the way out.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(tempDir, ADMINS_FILE_NAME), '{ not json', 'utf8')
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(
      ['approve', approvalId],
      io,
      optsWithToken('mcpa_a-syntactically-plausible-token'),
    )

    expect(exitCode).toBe(1)
    expect(io.err().length).toBeGreaterThan(0)
    // A message, not a crash dump: no stack frames leaking internals.
    expect(io.err()).not.toContain('    at ')
    expect(await queue.readResolution(approvalId)).toBeNull()
    expect((await queue.list()).map((entry) => entry.approvalId)).toContain(approvalId)
  })

  test('deny is refused the same way when the admin store cannot be read', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(tempDir, ADMINS_FILE_NAME), '{ not json', 'utf8')
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(
      ['deny', approvalId],
      io,
      optsWithToken('mcpa_a-syntactically-plausible-token'),
    )

    expect(exitCode).toBe(1)
    expect(await queue.readResolution(approvalId)).toBeNull()
  })

  test('an empty-string token is treated as no token, not as a token to look up', async () => {
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', approvalId], io, optsWithToken(''))

    expect(exitCode).toBe(1)
    expect(await queue.readResolution(approvalId)).toBeNull()
  })

  test('two admins resolving two requests produce two distinguishable actors', async () => {
    // The whole point of the change: the journal can tell one human from
    // another, which a constant `actor` could never do.
    const alice = await createAdminToken('alice')
    const bob = await createAdminToken('bob')
    const queue = createApprovalQueue({ baseDir })
    const first = await queue.enqueue(baseRequest())
    const second = await queue.enqueue(baseRequest({ sessionId: 'session-2' }))

    expect(await runApprovals(['approve', first.approvalId], fakeIo(), alice.opts)).toBe(0)
    expect(await runApprovals(['deny', second.approvalId], fakeIo(), bob.opts)).toBe(0)

    expect((await queue.readResolution(first.approvalId))?.actor).toBe('cli:alice')
    expect((await queue.readResolution(second.approvalId))?.actor).toBe('cli:bob')
  })

  test('the two failure modes are distinguishable for an operator', async () => {
    const missingIo = fakeIo()
    const unknownIo = fakeIo()

    await runApprovals(['approve', '01ARZ3NDEKTSV4RRFFQ69G5FAV'], missingIo, anonymousOpts())
    await runApprovals(
      ['approve', '01ARZ3NDEKTSV4RRFFQ69G5FAV'],
      unknownIo,
      optsWithToken('mcpa_this-token-was-never-issued'),
    )

    expect(missingIo.err()).not.toBe(unknownIo.err())
    expect(missingIo.err()).toContain(ADMIN_TOKEN_ENV_VAR)
    expect(unknownIo.err()).toContain(ADMIN_TOKEN_ENV_VAR)
  })

  test('no output on any path echoes the token, a prefix of it, or its length', async () => {
    const { token, opts } = await createAdminToken('release-captain')
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const bogus = 'mcpa_never-issued-token-value'
    const okIo = fakeIo()
    const unknownIo = fakeIo()
    const missingIo = fakeIo()

    await runApprovals(['approve', approvalId], okIo, opts)
    await runApprovals(['deny', approvalId], unknownIo, optsWithToken(bogus))
    await runApprovals(['deny', approvalId], missingIo, anonymousOpts())

    for (const io of [okIo, unknownIo, missingIo]) {
      // The approval id is echoed back on purpose (the operator needs to know
      // WHICH request was resolved), and it is a random ULID -- so the raw
      // `String(token.length)` check below hit it by chance whenever those two
      // digits happened to appear inside the id, failing a run that leaked
      // nothing. Masking the id keeps the assertion about the TOKEN, which is
      // what it was always meant to be about.
      const written = (io.out() + io.err()).replaceAll(approvalId, '<approval-id>')
      expect(written).not.toContain(token)
      expect(written).not.toContain(bogus)
      // Not even a leading slice: a "token starts with…" hint is still a leak.
      expect(written).not.toContain(token.slice(0, 12))
      expect(written).not.toContain(String(token.length))
    }
  })

  test('a viewer’s valid token cannot resolve: exit 1 and the request is still pending', async () => {
    // ADR-0004 gives `viewer` not a single POST action, and the UI route
    // `POST /approvals/:id/approve` requires `operator`. A CLI that only
    // checked "is this a real admin" would be a privilege escalation across
    // surfaces — and would let an audit report name a viewer as an approver.
    const { opts } = await createAdminToken('read-only-auditor', 'viewer')
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(['approve', approvalId], io, opts)

    expect(exitCode).toBe(1)
    expect(await queue.readResolution(approvalId)).toBeNull()
    expect((await queue.list()).map((entry) => entry.approvalId)).toContain(approvalId)
  })

  test('a viewer cannot deny either', async () => {
    const { opts } = await createAdminToken('read-only-auditor', 'viewer')
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const io = fakeIo()

    const exitCode = await runApprovals(['deny', approvalId], io, opts)

    expect(exitCode).toBe(1)
    expect(await queue.readResolution(approvalId)).toBeNull()
  })

  test('an owner outranks the operator minimum and may resolve', async () => {
    // Not an assumption: `ROLE_RANK` is asserted to agree, below.
    const { opts } = await createAdminToken('founder', 'owner')
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())

    const exitCode = await runApprovals(['approve', approvalId], fakeIo(), opts)

    expect(exitCode).toBe(0)
    expect((await queue.readResolution(approvalId))?.actor).toBe('cli:founder')
  })

  test('the CLI threshold IS the UI route’s threshold, from one definition', async () => {
    // Two sources of truth for privilege ordering is the bug that outlives us:
    // the UI route table and this command read the same constant.
    const approveRoute = ROUTE_TABLE.find(
      (entry) => entry.method === 'POST' && entry.pattern === '/approvals/:id/approve',
    )
    const denyRoute = ROUTE_TABLE.find(
      (entry) => entry.method === 'POST' && entry.pattern === '/approvals/:id/deny',
    )

    expect(approveRoute?.minRole).toBe(APPROVAL_RESOLVE_MIN_ROLE)
    expect(denyRoute?.minRole).toBe(APPROVAL_RESOLVE_MIN_ROLE)
    // And the ordering the CLI relies on is the one the UI relies on.
    expect(roleSatisfies('owner', APPROVAL_RESOLVE_MIN_ROLE)).toBe(true)
    expect(roleSatisfies('operator', APPROVAL_RESOLVE_MIN_ROLE)).toBe(true)
    expect(roleSatisfies('viewer', APPROVAL_RESOLVE_MIN_ROLE)).toBe(false)
  })

  test('the insufficient-role message names the requirement and nothing else about the account', async () => {
    const { token, opts } = await createAdminToken('read-only-auditor', 'viewer')
    const io = fakeIo()

    await runApprovals(['approve', '01ARZ3NDEKTSV4RRFFQ69G5FAV'], io, opts)

    const written = io.out() + io.err()
    expect(written).toMatch(/operator/)
    expect(written).not.toContain(token)
    expect(written).not.toContain(token.slice(0, 12))
  })

  test('list stays token-free: reading the queue is not an authorization event', async () => {
    // Even for a viewer, and even with no token exported at all: a regression
    // here would take the read path away from everyone.
    await createAdminToken('read-only-auditor', 'viewer')
    const queue = createApprovalQueue({ baseDir })
    const { approvalId } = await queue.enqueue(baseRequest())
    const readableIo = fakeIo()
    const jsonIo = fakeIo()

    const readableExit = await runApprovals(['list'], readableIo, anonymousOpts())
    const jsonExit = await runApprovals(['list', '--json'], jsonIo, anonymousOpts())

    expect(readableExit).toBe(0)
    expect(readableIo.out()).toContain(approvalId)
    expect(jsonExit).toBe(0)
    expect(JSON.parse(jsonIo.out()).approvals).toHaveLength(1)
  })
})

describe('runApprovals: unknown/missing subcommand', () => {
  test('no subcommand prints usage and returns 1', async () => {
    const io = fakeIo()

    const exitCode = await runApprovals([], io, { baseDir })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })

  test('unknown subcommand prints usage and returns 1', async () => {
    const io = fakeIo()

    const exitCode = await runApprovals(['bogus'], io, { baseDir })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })
})
