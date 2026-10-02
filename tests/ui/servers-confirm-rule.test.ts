import { describe, expect, test } from 'vitest'
import type { PolicyEditInfo } from '../../src/journal/policy-edit-record.js'
import type { PolicyFileReadResult, PolicyFileWriteResult } from '../../src/policy/edit/policy-file.js'
import { policyHashOf } from '../../src/policy/provenance.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { matchRoute, ROUTE_TABLE } from '../../src/ui/authz.js'
import { AUDIT_RECORD_DROPPED_WARNING } from '../../src/ui/constants.js'
import type { UiAuditEvent } from '../../src/ui/handlers/servers.js'
import { createServersConfirmRuleHandlers } from '../../src/ui/handlers/servers-confirm-rule.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'

/**
 * `POST /servers/:name/tools/:tool/confirm`: the owner-only write of the
 * client-confirmation rule. Same guarantees as the admin-rule route — fixed
 * path, hash compare-and-swap, a refusal never writes/journals/audits, a
 * success does each exactly once — pinned against injected ports.
 */

const OWNER = { adminName: 'alice', role: 'owner' as const, csrfToken: 'csrf' }
const OPERATOR = { adminName: 'bob', role: 'operator' as const, csrfToken: 'csrf' }

function policyOf(raw: unknown): Policy {
  const parsed = parsePolicy(raw)
  if (!parsed.ok) throw new Error('bad fixture')
  return parsed.policy
}

const BASE_DOCUMENT = { version: 1, servers: { github: { confirmInClient: { 'write_*': ['*'] } } } }
const BASE_HASH = policyHashOf(policyOf(BASE_DOCUMENT))
const LOADED: PolicyFileReadResult = {
  status: 'loaded',
  policy: policyOf(BASE_DOCUMENT),
  hash: BASE_HASH,
  raw: JSON.stringify(BASE_DOCUMENT),
  document: BASE_DOCUMENT,
}

interface HarnessOptions {
  readonly read?: PolicyFileReadResult
  readonly write?: PolicyFileWriteResult
  readonly journalDropped?: boolean
  readonly journalThrows?: boolean
}

function makeHarness(options: HarnessOptions = {}) {
  const writes: Array<{ path: string; document: unknown; expectedHash: string | null }> = []
  const journal: PolicyEditInfo[] = []
  const audit: UiAuditEvent[] = []
  const { serversConfirmRule } = createServersConfirmRuleHandlers({
    resolveEditTarget: async () => ({ path: '/state/policy.json', readers: { kind: 'every-entry-point' } }),
    readPolicyFile: async () => options.read ?? LOADED,
    writePolicyFile: async (path, document, opts) => {
      writes.push({ path, document, expectedHash: opts.expectedHash })
      if (options.write !== undefined) return options.write
      return { status: 'written', hashBefore: BASE_HASH, hashAfter: policyHashOf(policyOf(document)) }
    },
    journal: async (edit) => {
      if (options.journalThrows === true) throw new Error('journal down')
      journal.push(edit)
      return { written: options.journalDropped !== true }
    },
    audit: (event) => audit.push(event),
  })
  return { handler: serversConfirmRule, writes, journal, audit }
}

interface PostOptions {
  readonly name?: string
  readonly tool?: string
  readonly fields?: Record<string, unknown>
  readonly session?: UiRequestContext['session']
  readonly form?: boolean
}

function post(options: PostOptions = {}): UiRequestContext {
  const name = options.name ?? 'github'
  const tool = options.tool ?? 'create_issue'
  const fields = options.fields ?? { confirm: 'all', expected_hash: BASE_HASH }
  const body = options.form === true ? formBody(fields) : JSON.stringify(fields)
  return {
    method: 'POST',
    path: `/servers/${name}/tools/${tool}/confirm`,
    params: { name, tool },
    query: new URLSearchParams(),
    session: 'session' in options ? options.session : OWNER,
    body: Buffer.from(body, 'utf8'),
    headers: { 'content-type': options.form === true ? 'application/x-www-form-urlencoded' : 'application/json' },
  }
}

function formBody(fields: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item))
  }
  return params.toString()
}

function jsonOf(result: UiResult): Record<string, unknown> {
  if (result.kind !== 'response') throw new Error('expected a buffered response')
  return JSON.parse(String(result.body ?? '')) as Record<string, unknown>
}

function statusOf(result: UiResult): number {
  return result.kind === 'response' ? result.status : -1
}

describe('route', () => {
  test('owner-only row, both names captured undecoded', () => {
    const entry = ROUTE_TABLE.find((row) => row.pattern === '/servers/:name/tools/:tool/confirm')
    expect(entry).toMatchObject({ method: 'POST', minRole: 'owner', handler: 'serversConfirmRule' })
    expect(matchRoute('POST', '/servers/my%3Aserver/tools/create%20issue/confirm')?.params).toEqual({
      name: 'my%3Aserver',
      tool: 'create%20issue',
    })
  })
})

describe('success', () => {
  test('confirm=all writes ["*"] for the exact key, journals and audits once', async () => {
    const h = makeHarness()
    const result = await h.handler(post())
    expect(statusOf(result)).toBe(200)
    expect(jsonOf(result)).toMatchObject({ status: 'ok', server: 'github', tool: 'create_issue', confirm: 'all', agents: ['*'], journal: 'written' })
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]?.expectedHash).toBe(BASE_HASH)
    expect(h.writes[0]?.document).toEqual({
      version: 1,
      servers: { github: { confirmInClient: { 'write_*': ['*'], create_issue: ['*'] } } },
    })
    expect(h.journal).toHaveLength(1)
    expect(h.journal[0]).toMatchObject({ serverName: 'github', toolName: 'create_issue', rule: null, confirmInClient: ['*'] })
    expect(h.journal[0]?.actor).toEqual({ adminName: 'alice', role: 'owner', via: 'ui' })
    expect(h.audit).toEqual([{ actor: 'ui', adminName: 'alice', action: 'policy.confirm', target: 'github/create_issue all' }])
  })

  test('confirm=agents with repeated agent values (JSON array and form) writes the list', async () => {
    for (const form of [false, true]) {
      const h = makeHarness()
      const result = await h.handler(
        post({ form, fields: { confirm: 'agents', agent: ['laptop', 'alice-cursor'], expected_hash: BASE_HASH } }),
      )
      if (form) expect(statusOf(result)).toBe(303)
      else expect(jsonOf(result)).toMatchObject({ confirm: 'agents', agents: ['laptop', 'alice-cursor'] })
      expect(h.journal[0]?.confirmInClient).toEqual(['laptop', 'alice-cursor'])
    }
  })

  test('a single agent as a plain string works', async () => {
    const h = makeHarness()
    await h.handler(post({ fields: { confirm: 'agents', agent: 'laptop', expected_hash: BASE_HASH } }))
    expect(h.journal[0]?.confirmInClient).toEqual(['laptop'])
  })

  test('confirm=off removes only the exact key and journals null', async () => {
    const read: PolicyFileReadResult = {
      ...LOADED,
      document: { version: 1, servers: { github: { confirmInClient: { 'write_*': ['*'], create_issue: ['a'] } } } },
    }
    const h = makeHarness({ read })
    const result = await h.handler(post({ fields: { confirm: 'off', expected_hash: BASE_HASH } }))
    expect(jsonOf(result)).toMatchObject({ status: 'ok', confirm: 'off', agents: null })
    expect(h.writes[0]?.document).toEqual(BASE_DOCUMENT)
    expect(h.journal[0]?.confirmInClient).toBeNull()
    expect(h.audit[0]?.target).toBe('github/create_issue off')
  })

  test('a native form post answers 303 back to /servers', async () => {
    const result = await makeHarness().handler(post({ form: true }))
    expect(statusOf(result)).toBe(303)
    expect(result.kind === 'response' ? result.headers?.['location'] : '').toBe('/servers')
  })

  test('a dropped journal record is still a success and says so (JSON and notice page)', async () => {
    const json = await makeHarness({ journalDropped: true }).handler(post())
    expect(jsonOf(json)).toMatchObject({ status: 'ok', journal: 'dropped' })
    const form = await makeHarness({ journalDropped: true }).handler(post({ form: true }))
    expect(statusOf(form)).toBe(200)
    expect(String(form.kind === 'response' ? form.body : '')).toContain(AUDIT_RECORD_DROPPED_WARNING)
  })

  test('a throwing journal port never turns a written rule into a failure', async () => {
    const h = makeHarness({ journalThrows: true })
    const result = await h.handler(post())
    expect(statusOf(result)).toBe(200)
    expect(jsonOf(result)).toMatchObject({ journal: 'dropped' })
  })
})

describe('refusals never write, journal or audit', () => {
  async function refused(options: PostOptions, harness = makeHarness()): Promise<{ status: number; body: Record<string, unknown> }> {
    const result = await harness.handler(post(options))
    expect(harness.writes).toHaveLength(0)
    expect(harness.journal).toHaveLength(0)
    expect(harness.audit).toHaveLength(0)
    return { status: statusOf(result), body: jsonOf(result) }
  }

  test('a non-owner and a missing session are 403', async () => {
    expect((await refused({ session: OPERATOR })).status).toBe(403)
    expect((await refused({ session: undefined })).status).toBe(403)
  })

  test.each([
    ['bad server name', { name: 'bad%20name' }],
    ['undecodable server name', { name: '%E0%A4%A' }],
    ['wildcard tool', { tool: 'write_%2A' }],
    ['reserved tool', { tool: 'constructor' }],
    ['unknown confirm value', { fields: { confirm: 'sometimes', expected_hash: BASE_HASH } }],
    ['missing confirm', { fields: { expected_hash: BASE_HASH } }],
    ['missing expected_hash', { fields: { confirm: 'all' } }],
    ['agents without any agent', { fields: { confirm: 'agents', expected_hash: BASE_HASH } }],
    ['agents with an invalid name', { fields: { confirm: 'agents', agent: ['Alice'], expected_hash: BASE_HASH } }],
    ['agents with a star', { fields: { confirm: 'agents', agent: ['*'], expected_hash: BASE_HASH } }],
    ['agents with a non-string', { fields: { confirm: 'agents', agent: [1], expected_hash: BASE_HASH } }],
  ])('400: %s', async (_label, options) => {
    const { status, body } = await refused(options as PostOptions)
    expect(status).toBe(400)
    expect(String(body['message'])).not.toBe('')
  })

  test('a non-string agent in a JSON body is refused (no coercion)', async () => {
    const { status } = await refused({ fields: { confirm: 'agents', agent: [{ a: 1 }], expected_hash: BASE_HASH } })
    expect(status).toBe(400)
  })

  test('no policy and invalid policy are 409', async () => {
    const absent = await refused({}, makeHarness({ read: { status: 'absent' } as PolicyFileReadResult }))
    expect(absent).toMatchObject({ status: 409, body: { status: 'no-policy' } })
    const invalid = await refused({}, makeHarness({ read: { status: 'error', errors: ['bad'] } as PolicyFileReadResult }))
    expect(invalid).toMatchObject({ status: 409, body: { status: 'invalid-policy' } })
  })

  test('a hash conflict is 409 "reload the page and retry" (the write is attempted once, nothing is journaled)', async () => {
    const h = makeHarness({ write: { status: 'conflict' } as PolicyFileWriteResult })
    const result = await h.handler(post())
    expect(statusOf(result)).toBe(409)
    expect(String(jsonOf(result)['message'])).toContain('reload the page and retry')
    expect(h.journal).toHaveLength(0)
    expect(h.audit).toHaveLength(0)
  })

  test('a write failure is 500 and journals nothing', async () => {
    const h = makeHarness({ write: { status: 'error', errors: ['disk'] } as PolicyFileWriteResult })
    const result = await h.handler(post())
    expect(statusOf(result)).toBe(500)
    expect(h.journal).toHaveLength(0)
  })
})
