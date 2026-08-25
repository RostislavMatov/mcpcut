import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAdminStore } from '../../src/admin/store.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { composeUi, type UiComposition } from '../../src/cli/ui-wiring.js'
import { journalDbPathFor, openJournalDbShared } from '../../src/journal/db.js'
import { POLICY_EDIT_SESSION_ID } from '../../src/journal/policy-edit-record.js'
import { POLICY_FILE_NAME } from '../../src/policy/constants.js'
import { INVENTORY_FILE_NAME } from '../../src/policy/inventory-store.js'
import { loadPolicy } from '../../src/policy/load.js'
import { policyHashOf } from '../../src/policy/provenance.js'
import { createRegistryStore } from '../../src/registry/store.js'
import { createEventHub } from '../../src/ui/events.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'
import { createVaultStore } from '../../src/vault/store.js'

/**
 * Wiring smoke for the per-tool rule edit (plan policy-tool-rules-ui wave 4):
 * the production handler map from `composeUi` against a REAL temp journal
 * dir with a real `policy.json`. A POST rewrites the file (the write path is
 * `<journalDir>/policy.json`, bound in the composition root), the page's
 * view reflects it, a stale CAS token is refused, the audit line reaches
 * stderr and the `policy-edit` record lands in `journal.db`.
 */

const OWNER = { adminName: 'alice', role: 'owner' as const, csrfToken: 'csrf' }

let dir = ''
let stderr: string[] = []
let composed: UiComposition

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-ui-wiring-policy-'))
  stderr = []
  await writeFile(join(dir, POLICY_FILE_NAME), '{"version":1}\n', 'utf8')
  const registry = createRegistryStore(dir)
  await registry.addServer({ name: 'github', transport: 'stdio', command: 'gh-mcp' })
  composed = composeUi({
    journalDir: dir,
    approvalsBaseDir: join(dir, 'approvals'),
    inventoryStorePath: join(dir, INVENTORY_FILE_NAME),
    adminStore: createAdminStore({ journalDir: dir }),
    agents: createAgentsStore({ journalDir: dir }),
    registry,
    vault: createVaultStore({ journalDir: dir }),
    hub: createEventHub(),
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    env: {},
    cwd: dir,
  })
})

afterEach(async () => {
  await composed.closeProbes()
  await rm(dir, { recursive: true, force: true })
})

async function currentHash(): Promise<string> {
  const loaded = await loadPolicy({ explicitPath: join(dir, POLICY_FILE_NAME), cwd: dir })
  if (loaded.status !== 'loaded') throw new Error(`policy not loadable: ${JSON.stringify(loaded)}`)
  return policyHashOf(loaded.policy)
}

function postRule(rule: string, expectedHash: string): UiRequestContext {
  return {
    method: 'POST',
    path: '/servers/github/tools/create_issue/rule',
    params: { name: 'github', tool: 'create_issue' },
    query: new URLSearchParams(),
    session: OWNER,
    body: Buffer.from(JSON.stringify({ rule, expected_hash: expectedHash }), 'utf8'),
    headers: { 'content-type': 'application/json' },
  }
}

function bodyOf(result: UiResult): string {
  return result.kind === 'response' ? String(result.body ?? '') : ''
}

async function journaledEdits(): Promise<Record<string, unknown>[]> {
  const handle = await openJournalDbShared(journalDbPathFor(dir))
  const rows = handle.db
    .prepare('SELECT session_id AS sessionId, kind, doc FROM journal_records ORDER BY seq')
    .all() as { sessionId: string; kind: string; doc: string }[]
  return rows
    .filter((row) => row.sessionId === POLICY_EDIT_SESSION_ID && row.kind === 'policy-edit')
    .map((row) => (JSON.parse(row.doc) as { payload: Record<string, unknown> }).payload)
}

describe('composeUi: the rule handler writes <journalDir>/policy.json with CAS', () => {
  test('a POST sets the rule on disk, journals it and audits it; a stale token is then refused', async () => {
    const handler = composed.handlers.serversToolRule
    expect(handler).toBeDefined()
    const before = await currentHash()

    const first = await handler(postRule('deny', before))
    expect(first.kind === 'response' && first.status).toBe(200)
    expect(JSON.parse(bodyOf(first))).toMatchObject({ status: 'ok', effective: { outcome: 'deny', source: 'explicit' } })

    const text = await readFile(join(dir, POLICY_FILE_NAME), 'utf8')
    expect(JSON.parse(text)).toEqual({ version: 1, servers: { github: { tools: { create_issue: 'deny' } } } })
    expect(text.endsWith('\n')).toBe(true)
    const after = await currentHash()
    expect(after).not.toBe(before)

    expect(stderr.join('')).toContain('[ui] alice policy.set github/create_issue deny')
    const edits = await journaledEdits()
    expect(edits).toHaveLength(1)
    expect(edits[0]).toMatchObject({
      actor: { adminName: 'alice', role: 'owner', via: 'ui' },
      serverName: 'github',
      toolName: 'create_issue',
      rule: 'deny',
      policyHashBefore: before,
      policyHashAfter: after,
      sourcePath: join(dir, POLICY_FILE_NAME),
    })

    // The page the token came from is stale now: same token → 409, file untouched.
    const stale = await handler(postRule('allow', before))
    expect(stale.kind === 'response' && stale.status).toBe(409)
    expect(JSON.parse(bodyOf(stale)).status).toBe('conflict')
    expect(JSON.parse(await readFile(join(dir, POLICY_FILE_NAME), 'utf8'))).toEqual({
      version: 1,
      servers: { github: { tools: { create_issue: 'deny' } } },
    })
    expect(await journaledEdits()).toHaveLength(1)
  })

  test('the servers page renders the loaded policy view: sources line, pill and controls', async () => {
    const before = await currentHash()
    await composed.handlers.serversToolRule(postRule('require-approval', before))
    const page = await composed.handlers.serversPage({
      method: 'GET',
      path: '/servers',
      params: {},
      query: new URLSearchParams(),
      session: OWNER,
      body: Buffer.alloc(0),
      headers: {},
    })
    const html = bodyOf(page)
    expect(html).toContain(`policy · <code>${join(dir, POLICY_FILE_NAME)}</code>`)
    expect(html).toContain(`<span class="num">${(await currentHash()).slice(0, 8)}</span>`)
    // The inventory has no tools yet, so no rule rows; the region is there for the settle.
    expect(html).toContain('data-live-region="server-tools:github"')
  })

  test('a shadowing nested file refuses the edit and the page says so (finding 5a)', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, '.mcp-journal'), { recursive: true })
    await writeFile(join(dir, '.mcp-journal', POLICY_FILE_NAME), '{"version":1}\n', 'utf8')

    const result = await composed.handlers.serversToolRule(postRule('deny', await currentHash()))
    expect(result.kind === 'response' && result.status).toBe(409)
    expect(JSON.parse(bodyOf(result)).status).toBe('shadowed')
    expect(JSON.parse(await readFile(join(dir, POLICY_FILE_NAME), 'utf8'))).toEqual({ version: 1 })
    expect(await journaledEdits()).toHaveLength(0)
  })
})
