import { describe, expect, test } from 'vitest'
import type { PolicyJournalEdit } from '../../src/journal/policy-edit-record.js'
import { CREATED_POLICY_DOCUMENT } from '../../src/policy/edit/created-policy.js'
import type { PolicyFileReadResult, PolicyFileWriteResult } from '../../src/policy/edit/policy-file.js'
import { policyHashOf } from '../../src/policy/provenance.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { TENANT_SETTINGS } from '../../src/tenant/settings.js'
import { matchRoute, ROUTE_TABLE } from '../../src/ui/authz.js'
import { AUDIT_RECORD_DROPPED_WARNING } from '../../src/ui/constants.js'
import { createServersCreatePolicyHandlers } from '../../src/ui/handlers/servers-create-policy.js'
import type { UiAuditEvent } from '../../src/ui/handlers/servers.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'

/**
 * `POST /servers/create-policy` (ADR-0009, amendment 2026-10-02): the one
 * explicit action that turns "no policy" into a file. Owner-only, the path is
 * the one this process resolved, the write expects NO file (compare-and-swap
 * on `null`), the document is the fixed allow-everything starter, and a
 * success is journaled and audited exactly once — a refusal does neither.
 */

const OWNER = { adminName: 'alice', role: 'owner' as const, csrfToken: 'csrf' }
const OPERATOR = { adminName: 'bob', role: 'operator' as const, csrfToken: 'csrf' }
const TARGET = '/state/policy.json'

function policyOf(raw: unknown): Policy {
  const parsed = parsePolicy(raw)
  if (!parsed.ok) throw new Error('bad fixture')
  return parsed.policy
}

const CREATED_HASH = policyHashOf(policyOf(CREATED_POLICY_DOCUMENT))
const EXISTING = { version: 1 }
const LOADED: PolicyFileReadResult = {
  status: 'loaded',
  policy: policyOf(EXISTING),
  hash: policyHashOf(policyOf(EXISTING)),
  raw: JSON.stringify(EXISTING),
  document: EXISTING,
}

interface HarnessOptions {
  readonly read?: PolicyFileReadResult
  readonly write?: PolicyFileWriteResult
  readonly journalDropped?: boolean
  readonly journalThrows?: boolean
  readonly isTenant?: boolean
}

function makeHarness(options: HarnessOptions = {}) {
  const writes: Array<{ path: string; document: unknown; expectedHash: string | null }> = []
  const journal: PolicyJournalEdit[] = []
  const audit: UiAuditEvent[] = []
  const { serversCreatePolicy } = createServersCreatePolicyHandlers({
    resolveEditTarget: async () => ({ path: TARGET, readers: { kind: 'every-entry-point' } }),
    readPolicyFile: async () => options.read ?? { status: 'absent' },
    writePolicyFile: async (path, document, opts) => {
      writes.push({ path, document, expectedHash: opts.expectedHash })
      return options.write ?? { status: 'written', hashBefore: null, hashAfter: CREATED_HASH }
    },
    journal: async (edit) => {
      if (options.journalThrows === true) throw new Error('journal down')
      journal.push(edit)
      return { written: options.journalDropped !== true }
    },
    audit: (event) => audit.push(event),
    tenant: { ...TENANT_SETTINGS, isTenant: options.isTenant === true },
  })
  return { handler: serversCreatePolicy, writes, journal, audit }
}

interface PostOptions {
  readonly session?: UiRequestContext['session']
  readonly json?: boolean
}

function post(options: PostOptions = {}): UiRequestContext {
  const isJson = options.json === true
  return {
    method: 'POST',
    path: '/servers/create-policy',
    params: {},
    query: new URLSearchParams(),
    session: 'session' in options ? options.session : OWNER,
    body: Buffer.from(isJson ? '{}' : 'csrf_token=csrf', 'utf8'),
    headers: { 'content-type': isJson ? 'application/json' : 'application/x-www-form-urlencoded' },
  }
}

function statusOf(result: UiResult): number {
  return result.kind === 'response' ? result.status : -1
}

function bodyOf(result: UiResult): string {
  return result.kind === 'response' ? String(result.body ?? '') : ''
}

function jsonOf(result: UiResult): Record<string, unknown> {
  return JSON.parse(bodyOf(result)) as Record<string, unknown>
}

describe('route', () => {
  test('an owner-only POST row', () => {
    const entry = ROUTE_TABLE.find((row) => row.pattern === '/servers/create-policy')
    expect(entry).toMatchObject({ method: 'POST', minRole: 'owner', handler: 'serversCreatePolicy' })
    expect(matchRoute('POST', '/servers/create-policy')?.entry.handler).toBe('serversCreatePolicy')
  })
})

describe('the starter it writes', () => {
  test('allows every call with quarantine off — the outcomes of running with no policy file', () => {
    expect(CREATED_POLICY_DOCUMENT).toEqual({ version: 1, defaultDecision: 'allow', quarantine: { enabled: false } })
    const policy = policyOf(CREATED_POLICY_DOCUMENT)
    expect(policy.defaultDecision).toBe('allow')
    expect(policy.quarantine.enabled).toBe(false)
    expect(policy.journal.failClosed).toBe(false)
    expect(Object.isFrozen(CREATED_POLICY_DOCUMENT)).toBe(true)
  })
})

describe('success', () => {
  test('writes the starter to the resolved path expecting no file, journals and audits once', async () => {
    const h = makeHarness()
    const result = await h.handler(post())
    expect(statusOf(result)).toBe(200)
    expect(h.writes).toEqual([{ path: TARGET, document: CREATED_POLICY_DOCUMENT, expectedHash: null }])
    expect(h.journal).toEqual([
      {
        actor: { adminName: 'alice', role: 'owner', via: 'ui' },
        created: true,
        policyHashBefore: null,
        policyHashAfter: CREATED_HASH,
        sourcePath: TARGET,
      },
    ])
    expect(h.audit).toEqual([{ actor: 'ui', adminName: 'alice', action: 'policy.create', target: TARGET }])
  })

  test('the form answer names the file and the next step: restart the client once, then choose tools', async () => {
    const html = bodyOf(await makeHarness().handler(post()))
    expect(html).toContain('<h1>Done</h1>')
    expect(html).toContain(`Created ${TARGET}`)
    expect(html).toContain('nothing asks you until you choose tools')
    expect(html).toContain('restart your client once')
    expect(html).toContain('<a href="/servers">Choose tools on Servers</a>')
    expect(html).not.toContain(AUDIT_RECORD_DROPPED_WARNING)
  })

  test('a JSON caller gets the path, the new hash and the journal verdict', async () => {
    const result = await makeHarness().handler(post({ json: true }))
    expect(statusOf(result)).toBe(200)
    expect(jsonOf(result)).toEqual({ status: 'ok', path: TARGET, hashAfter: CREATED_HASH, journal: 'written' })
  })

  test('a dropped journal record is still a success, and says so', async () => {
    const form = await makeHarness({ journalDropped: true }).handler(post())
    expect(statusOf(form)).toBe(200)
    expect(bodyOf(form)).toContain(AUDIT_RECORD_DROPPED_WARNING)
    const json = await makeHarness({ journalThrows: true }).handler(post({ json: true }))
    expect(jsonOf(json)).toMatchObject({ status: 'ok', journal: 'dropped' })
  })
})

describe('refusals write nothing, journal nothing, audit nothing', () => {
  test('a non-owner session is 403', async () => {
    for (const session of [OPERATOR, undefined]) {
      const h = makeHarness()
      const result = await h.handler(post({ session, json: true }))
      expect(statusOf(result)).toBe(403)
      expect(h.writes).toHaveLength(0)
      expect(h.journal).toHaveLength(0)
      expect(h.audit).toHaveLength(0)
    }
  })

  test('a hosted (tenant) install is refused', async () => {
    const h = makeHarness({ isTenant: true })
    const result = await h.handler(post({ json: true }))
    expect(statusOf(result)).toBe(403)
    expect(h.writes).toHaveLength(0)
  })

  test('a policy that already exists is never overwritten: 409, and the form says what to do', async () => {
    const h = makeHarness({ read: LOADED })
    const json = await h.handler(post({ json: true }))
    expect(statusOf(json)).toBe(409)
    expect(jsonOf(json)).toMatchObject({ status: 'exists' })
    const form = await h.handler(post())
    expect(statusOf(form)).toBe(409)
    expect(bodyOf(form)).toContain(`A policy already exists at ${TARGET} — nothing was changed`)
    expect(bodyOf(form)).toContain('<a href="/servers">Choose tools on Servers</a>')
    expect(h.writes).toHaveLength(0)
    expect(h.journal).toHaveLength(0)
    expect(h.audit).toHaveLength(0)
  })

  test('a file that appears between the read and the write (the CAS on null) is the same 409', async () => {
    const h = makeHarness({ write: { status: 'conflict', currentHash: 'c'.repeat(64) } })
    const result = await h.handler(post({ json: true }))
    expect(statusOf(result)).toBe(409)
    expect(jsonOf(result)).toMatchObject({ status: 'exists' })
    expect(h.journal).toHaveLength(0)
    expect(h.audit).toHaveLength(0)
  })

  test('an invalid file on disk is 409 with its errors, never replaced', async () => {
    const h = makeHarness({ read: { status: 'error', errors: ['defaultDecision: invalid'] } })
    const result = await h.handler(post({ json: true }))
    expect(statusOf(result)).toBe(409)
    expect(jsonOf(result)).toMatchObject({ status: 'invalid-policy', errors: [`${TARGET}: defaultDecision: invalid`] })
    expect(h.writes).toHaveLength(0)
  })

  test('a failed write is 500 with the reason, and nothing is journaled', async () => {
    const h = makeHarness({ write: { status: 'error', errors: ['EACCES: permission denied'] } })
    const json = await h.handler(post({ json: true }))
    expect(statusOf(json)).toBe(500)
    expect(jsonOf(json)).toMatchObject({ status: 'error', errors: ['EACCES: permission denied'] })
    const form = await h.handler(post())
    expect(statusOf(form)).toBe(500)
    expect(bodyOf(form)).toContain('EACCES: permission denied')
    expect(h.journal).toHaveLength(0)
    expect(h.audit).toHaveLength(0)
  })
})
