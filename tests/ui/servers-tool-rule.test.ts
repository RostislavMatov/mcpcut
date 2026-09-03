import { describe, expect, test } from 'vitest'
import type { PolicyEditInfo } from '../../src/journal/policy-edit-record.js'
import type { PolicyFileReadResult, PolicyFileWriteResult } from '../../src/policy/edit/policy-file.js'
import type { PolicyEditTarget } from '../../src/policy/edit/write-target.js'
import type { InventoryStoreData } from '../../src/policy/inventory-store.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { policyHashOf } from '../../src/policy/provenance.js'
import { matchRoute, ROUTE_TABLE } from '../../src/ui/authz.js'
import { AUDIT_RECORD_DROPPED_WARNING } from '../../src/ui/constants.js'
import type { UiAuditEvent } from '../../src/ui/handlers/servers.js'
import {
  createServersToolRuleHandlers,
  type ServersToolRuleDeps,
} from '../../src/ui/handlers/servers-tool-rule.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'

/**
 * `POST /servers/:name/tools/:tool/rule` (plan policy-tool-rules-ui §6,
 * wave 4): the ONE HTTP path that writes `policy.json`. Every outcome is
 * pinned here against injected file/journal ports — the path is fixed by
 * the composition root and never read from the request; a refusal never
 * writes, journals or audits; a success does each exactly once.
 */

const FLAT = '/state/policy.json'
const NESTED = '/state/.mcp-journal/policy.json'
const OWNER = { adminName: 'alice', role: 'owner' as const, csrfToken: 'csrf' }
const OPERATOR = { adminName: 'bob', role: 'operator' as const, csrfToken: 'csrf' }

function policyOf(raw: unknown): Policy {
  const parsed = parsePolicy(raw)
  if (!parsed.ok) throw new Error('bad fixture')
  return parsed.policy
}

const BASE_DOCUMENT = { version: 1, servers: { github: { tools: { 'search_*': 'allow' } } } }
const BASE_POLICY = policyOf(BASE_DOCUMENT)
const BASE_HASH = policyHashOf(BASE_POLICY)

const LOADED: PolicyFileReadResult = {
  status: 'loaded',
  policy: BASE_POLICY,
  hash: BASE_HASH,
  raw: JSON.stringify(BASE_DOCUMENT),
  document: BASE_DOCUMENT,
}

const INVENTORY: InventoryStoreData = {
  version: 1,
  servers: {
    github: {
      approved: { create_issue: { schemaHash: 'h1', approvedAt: '2026-08-01T00:00:00.000Z' } },
      quarantined: {},
    },
  },
}

interface WriteCall {
  readonly path: string
  readonly document: unknown
  readonly expectedHash: string | null
}

interface Harness {
  readonly handler: (ctx: UiRequestContext) => Promise<UiResult> | UiResult
  readonly writes: WriteCall[]
  readonly journal: PolicyEditInfo[]
  readonly audit: UiAuditEvent[]
}

interface HarnessOptions {
  readonly target?: PolicyEditTarget
  readonly read?: PolicyFileReadResult
  readonly write?: PolicyFileWriteResult
  readonly inventory?: InventoryStoreData
  /** Makes the display-only inventory read reject, as a corrupt or locked store does. */
  readonly inventoryFails?: boolean
  /** Makes the journal writer answer `written: false` — the record was dropped after the file landed. */
  readonly journalDropped?: boolean
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const writes: WriteCall[] = []
  const journal: PolicyEditInfo[] = []
  const audit: UiAuditEvent[] = []
  const deps: ServersToolRuleDeps = {
    resolveEditTarget: async () => options.target ?? { path: FLAT, readers: { kind: 'every-entry-point' } },
    readPolicyFile: async () => options.read ?? LOADED,
    writePolicyFile: async (path, document, opts) => {
      writes.push({ path, document, expectedHash: opts.expectedHash })
      if (options.write !== undefined) return options.write
      const parsed = parsePolicy(document)
      if (!parsed.ok) throw new Error('unexpected: handler wrote an unparseable document')
      return { status: 'written', hashBefore: BASE_HASH, hashAfter: policyHashOf(parsed.policy) }
    },
    readInventory: async () => {
      if (options.inventoryFails === true) throw new Error('inventory store is corrupt')
      return options.inventory ?? INVENTORY
    },
    journal: async (edit) => {
      journal.push(edit)
      return { written: options.journalDropped !== true }
    },
    audit: (event) => audit.push(event),
  }
  const { serversToolRule } = createServersToolRuleHandlers(deps)
  return { handler: serversToolRule, writes, journal, audit }
}

interface PostOptions {
  readonly name?: string
  readonly tool?: string
  readonly fields?: Record<string, string>
  readonly session?: UiRequestContext['session']
  readonly form?: boolean
}

function post(options: PostOptions = {}): UiRequestContext {
  const name = options.name ?? 'github'
  const tool = options.tool ?? 'create_issue'
  const fields = options.fields ?? { rule: 'deny', expected_hash: BASE_HASH }
  const isForm = options.form === true
  return {
    method: 'POST',
    path: `/servers/${name}/tools/${tool}/rule`,
    params: { name, tool },
    query: new URLSearchParams(),
    session: 'session' in options ? options.session : OWNER,
    body: Buffer.from(isForm ? new URLSearchParams(fields).toString() : JSON.stringify(fields), 'utf8'),
    headers: { 'content-type': isForm ? 'application/x-www-form-urlencoded' : 'application/json' },
  }
}

function jsonOf(result: UiResult): Record<string, unknown> {
  if (result.kind !== 'response') throw new Error('expected a buffered response')
  return JSON.parse(String(result.body ?? '')) as Record<string, unknown>
}

function statusOf(result: UiResult): number {
  return result.kind === 'response' ? result.status : -1
}

describe('route', () => {
  test('the owner-only row exists and captures both names without decoding them', () => {
    const entry = ROUTE_TABLE.find((row) => row.pattern === '/servers/:name/tools/:tool/rule')
    expect(entry).toMatchObject({ method: 'POST', minRole: 'owner', handler: 'serversToolRule' })
    const match = matchRoute('POST', '/servers/my%3Aserver/tools/create%20issue/rule')
    expect(match?.params).toEqual({ name: 'my%3Aserver', tool: 'create%20issue' })
  })
})

/**
 * The inventory read only refines the display-only `effective` line. It runs
 * AFTER the edit is durably on disk, so a corrupt or lock-contended store must
 * never leave a written rule unattributed (no journal record, no audit line) —
 * the review's HIGH finding.
 */
describe('a completed write is attributed even when the inventory read fails', () => {
  test('journals, audits and answers ok when readInventory rejects', async () => {
    const harness = makeHarness({ inventoryFails: true })
    const result = await harness.handler(post({ fields: { rule: 'deny', expected_hash: BASE_HASH } }))
    expect(statusOf(result)).toBe(200)
    expect(harness.writes).toHaveLength(1)
    expect(harness.journal).toHaveLength(1)
    expect(harness.audit).toHaveLength(1)
    expect(jsonOf(result)).toMatchObject({ status: 'ok' })
  })
})

describe('refusals never write, journal or audit', () => {
  test('no session → 403', async () => {
    const h = makeHarness()
    const result = await h.handler(post({ session: undefined }))
    expect(statusOf(result)).toBe(403)
    expect(h.writes).toEqual([])
    expect(h.journal).toEqual([])
    expect(h.audit).toEqual([])
  })

  test('a non-owner session → 403 even if authz were bypassed', async () => {
    const h = makeHarness()
    const result = await h.handler(post({ session: OPERATOR }))
    expect(statusOf(result)).toBe(403)
    expect(h.writes).toEqual([])
  })

  test.each([
    ['unknown rule', { rule: 'maybe', expected_hash: BASE_HASH }],
    ['missing rule', { expected_hash: BASE_HASH }],
    ['missing expected_hash', { rule: 'deny' }],
    ['empty expected_hash', { rule: 'deny', expected_hash: '' }],
  ])('invalid field (%s) → 400', async (_label, fields) => {
    const h = makeHarness()
    const result = await h.handler(post({ fields }))
    expect(statusOf(result)).toBe(400)
    expect(jsonOf(result).status).toBe('invalid')
    expect(h.writes).toEqual([])
    expect(h.journal).toEqual([])
  })

  test.each([
    ['wildcard tool', 'github', 'search_*'],
    ['traversal tool', 'github', '..%2Fx'],
    ['double-encoded space decodes once and stays invalid', 'github', 'create%2520issue'],
    ['reserved key', 'github', '__proto__'],
    ['bad server name', 'git hub', 'create_issue'],
    ['malformed percent escape', 'github', '%E0%A4%A'],
  ])('invalid path names (%s) → 400', async (_label, name, tool) => {
    const h = makeHarness()
    const result = await h.handler(post({ name, tool }))
    expect(statusOf(result)).toBe(400)
    expect(h.writes).toEqual([])
  })

  /**
   * Correction 2026-08-26: the target is the file this process loaded, so an
   * edit always reaches whoever loaded it. A file `connect` does not read is
   * a displayed statement, never a refusal — the write goes through.
   */
  test('a target connect does not read is written all the same, and journaled with that path', async () => {
    const h = makeHarness({ target: { path: NESTED, readers: { kind: 'connect-unset' } } })

    const result = await h.handler(post())

    expect(result.kind === 'response' && result.status).toBe(200)
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]?.path).toBe(NESTED)
    expect(h.journal[0]?.sourcePath).toBe(NESTED)
  })

  test('no policy file → 409 "no policy — enforcement off" and the file is NOT created (O4)', async () => {
    const h = makeHarness({ read: { status: 'absent' } })
    const result = await h.handler(post())
    expect(statusOf(result)).toBe(409)
    expect(jsonOf(result).status).toBe('no-policy')
    expect(String(jsonOf(result).message)).toContain('enforcement off')
    expect(h.writes).toEqual([])
  })

  test('an invalid policy on disk → 409 carrying the errors (O3)', async () => {
    const h = makeHarness({ read: { status: 'error', errors: ['version: expected 1'] } })
    const result = await h.handler(post())
    expect(statusOf(result)).toBe(409)
    expect(jsonOf(result)).toMatchObject({ status: 'invalid-policy', errors: ['version: expected 1'] })
    expect(h.writes).toEqual([])
  })

  test('a CAS conflict → 409 "policy changed on disk — reload"', async () => {
    const h = makeHarness({ write: { status: 'conflict', currentHash: 'c'.repeat(64) } })
    const result = await h.handler(post({ fields: { rule: 'deny', expected_hash: 'stale' } }))
    expect(statusOf(result)).toBe(409)
    expect(jsonOf(result).status).toBe('conflict')
    expect(String(jsonOf(result).message)).toContain('reload')
    expect(h.journal).toEqual([])
    expect(h.audit).toEqual([])
  })

  test('an edit the document cannot take → 400 with the message', async () => {
    const broken = { version: 1, servers: { github: 'not-an-object' } }
    const h = makeHarness({
      read: { ...LOADED, document: broken, raw: JSON.stringify(broken) },
    })
    const result = await h.handler(post())
    expect(statusOf(result)).toBe(400)
    expect(jsonOf(result).status).toBe('invalid')
    expect(h.writes).toEqual([])
  })

  test('a failed write → 500 and no journal record', async () => {
    const h = makeHarness({ write: { status: 'error', errors: ['cannot write policy file: EACCES'] } })
    const result = await h.handler(post())
    expect(statusOf(result)).toBe(500)
    expect(h.journal).toEqual([])
    expect(h.audit).toEqual([])
  })
})

describe('success', () => {
  test('JSON request → JSON result with the effective outcome and hashes', async () => {
    const h = makeHarness()
    const result = await h.handler(post())
    expect(statusOf(result)).toBe(200)
    const body = jsonOf(result)
    expect(body).toMatchObject({
      status: 'ok',
      server: 'github',
      tool: 'create_issue',
      rule: 'deny',
      effective: { outcome: 'deny', source: 'explicit' },
      hashBefore: BASE_HASH,
    })
    expect(typeof body.hashAfter).toBe('string')
    expect(body.hashAfter).not.toBe(BASE_HASH)
  })

  test('the written path is the resolved target, never anything from the request body', async () => {
    const h = makeHarness()
    await h.handler(post({ fields: { rule: 'deny', expected_hash: BASE_HASH, path: '/etc/passwd', sourcePath: '/x' } }))
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0]?.path).toBe(FLAT)
    expect(h.writes[0]?.expectedHash).toBe(BASE_HASH)
    expect(h.writes[0]?.document).toEqual({
      version: 1,
      servers: { github: { tools: { 'search_*': 'allow', create_issue: 'deny' } } },
    })
  })

  test('the journal record and the audit line are emitted exactly once, attributed to the admin via ui', async () => {
    const h = makeHarness()
    await h.handler(post())
    expect(h.journal).toHaveLength(1)
    expect(h.journal[0]).toMatchObject({
      actor: { adminName: 'alice', role: 'owner', via: 'ui' },
      serverName: 'github',
      toolName: 'create_issue',
      rule: 'deny',
      policyHashBefore: BASE_HASH,
      sourcePath: FLAT,
    })
    expect(h.audit).toEqual([
      { actor: 'ui', adminName: 'alice', action: 'policy.set', target: 'github/create_issue deny' },
    ])
  })

  test('a plain form POST → 303 back to /servers', async () => {
    const h = makeHarness()
    const result = await h.handler(post({ form: true }))
    expect(result).toMatchObject({ kind: 'response', status: 303, headers: { location: '/servers' } })
    expect(h.writes).toHaveLength(1)
  })

  test('JSON: the payload says the audit record was written', async () => {
    const h = makeHarness()
    const result = await h.handler(post())
    expect(statusOf(result)).toBe(200)
    expect(jsonOf(result)).toMatchObject({ status: 'ok', journal: 'written' })
  })

  test('JSON: a dropped audit record is reported as journal: "dropped" — still status ok, still 200 (audit F1)', async () => {
    const h = makeHarness({ journalDropped: true })
    const result = await h.handler(post())
    expect(statusOf(result)).toBe(200)
    expect(jsonOf(result)).toMatchObject({ status: 'ok', journal: 'dropped', rule: 'deny' })
    // The edit landed and was journaled ONCE (attempted); the drop is the sink's, not the handler's.
    expect(h.writes).toHaveLength(1)
    expect(h.journal).toHaveLength(1)
  })

  test('form POST: a dropped audit record renders a 200 notice with the warning instead of the redirect (audit F1)', async () => {
    const h = makeHarness({ journalDropped: true })
    const result = await h.handler(post({ form: true }))
    expect(statusOf(result)).toBe(200)
    if (result.kind !== 'response') throw new Error('expected a buffered response')
    const body = String(result.body ?? '')
    expect(body).toContain(AUDIT_RECORD_DROPPED_WARNING)
    expect(body).toContain('class="notice ok')
    expect(h.writes).toHaveLength(1)
  })

  test('rule=clear removes the exact rule and journals a null rule', async () => {
    const withRule = { version: 1, servers: { github: { tools: { create_issue: 'deny' } } } }
    const policy = policyOf(withRule)
    const h = makeHarness({
      read: { status: 'loaded', policy, hash: policyHashOf(policy), raw: '', document: withRule },
    })
    const result = await h.handler(post({ fields: { rule: 'clear', expected_hash: policyHashOf(policy) } }))
    expect(statusOf(result)).toBe(200)
    expect(jsonOf(result)).toMatchObject({ rule: null, effective: { source: 'global-default' } })
    expect(h.writes[0]?.document).toEqual({ version: 1 })
    expect(h.journal[0]?.rule).toBeNull()
    expect(h.audit[0]?.target).toBe('github/create_issue clear')
  })

  test('the effective outcome after the edit accounts for quarantine when the rule is cleared', async () => {
    const quarantined: InventoryStoreData = {
      version: 1,
      servers: {
        github: {
          approved: {},
          quarantined: {
            create_issue: {
              schemaHash: 'h',
              firstSeenAt: '2026-08-01T00:00:00.000Z',
              state: 'new',
              descriptor: { name: 'create_issue' },
            },
          },
        },
      },
    }
    const h = makeHarness({ inventory: quarantined })
    const result = await h.handler(post({ fields: { rule: 'clear', expected_hash: BASE_HASH } }))
    expect(jsonOf(result)).toMatchObject({ effective: { source: 'quarantine' } })
  })

  test('percent-encoded names are decoded exactly once before validation and use', async () => {
    const h = makeHarness()
    const result = await h.handler(post({ name: 'my%3Aserver', tool: 'create%3Aissue' }))
    expect(statusOf(result)).toBe(200)
    expect(jsonOf(result)).toMatchObject({ server: 'my:server', tool: 'create:issue' })
  })
})
