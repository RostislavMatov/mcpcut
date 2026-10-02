import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAdminStore } from '../../src/admin/store.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { composeUi, type UiComposition } from '../../src/cli/ui-wiring.js'
import { journalDbPathFor, openJournalDbShared } from '../../src/journal/db.js'
import { POLICY_EDIT_SESSION_ID } from '../../src/journal/policy-edit-record.js'
import { POLICY_FILE_NAME } from '../../src/policy/constants.js'
import { CREATED_POLICY_DOCUMENT } from '../../src/policy/edit/created-policy.js'
import { INVENTORY_FILE_NAME } from '../../src/policy/inventory-store.js'
import { loadPolicy } from '../../src/policy/load.js'
import { policyHashOf } from '../../src/policy/provenance.js'
import { createRegistryStore } from '../../src/registry/store.js'
import { createEventHub } from '../../src/ui/events.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'
import { createVaultStore } from '../../src/vault/store.js'

/**
 * Wiring smoke for "Create policy" (ADR-0009, amendment 2026-10-02): the
 * production handler map from `composeUi` over a REAL temp state dir with NO
 * `policy.json`. The page offers the button, a POST writes the starter where
 * every entry point looks last (`<journalDir>/policy.json`), the file loads,
 * the record lands in `journal.db`, a second POST changes nothing, and the
 * per-tool rule route then edits the new file.
 */

const OWNER = { adminName: 'alice', role: 'owner' as const, csrfToken: 'csrf' }

let dir = ''
let stderr: string[] = []
let composed: UiComposition

beforeEach(async () => {
  stderr = []
  dir = await mkdtemp(join(tmpdir(), 'mcp-ui-wiring-create-'))
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

function request(method: 'GET' | 'POST', path: string, body: string, contentType?: string): UiRequestContext {
  return {
    method,
    path,
    params: {},
    query: new URLSearchParams(),
    session: OWNER,
    body: Buffer.from(body, 'utf8'),
    headers: contentType === undefined ? {} : { 'content-type': contentType },
  }
}

const createForm = (): UiRequestContext =>
  request('POST', '/servers/create-policy', 'csrf_token=csrf', 'application/x-www-form-urlencoded')

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

describe('composeUi: Create policy', () => {
  test('the page offers it, a POST writes the loadable starter, journals it, and the rules then edit it', async () => {
    const path = join(dir, POLICY_FILE_NAME)
    const before = bodyOf(await composed.handlers.serversPage(request('GET', '/servers', '')))
    expect(before).toContain('action="/servers/create-policy"')
    expect(before).toContain(`Writes <code>${path}</code>`)

    const created = await composed.handlers.serversCreatePolicy(createForm())
    expect(created.kind === 'response' && created.status).toBe(200)
    expect(bodyOf(created)).toContain(`Created ${path}`)

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(CREATED_POLICY_DOCUMENT)
    const loaded = await loadPolicy({ explicitPath: path, cwd: dir })
    if (loaded.status !== 'loaded') throw new Error(`starter not loadable: ${JSON.stringify(loaded)}`)
    const hash = policyHashOf(loaded.policy)

    expect(stderr.join('')).toContain(`[ui] alice policy.create ${path}`)
    expect(await journaledEdits()).toEqual([
      {
        actor: { adminName: 'alice', role: 'owner', via: 'ui' },
        created: true,
        policyHashBefore: null,
        policyHashAfter: hash,
        sourcePath: path,
      },
    ])

    const after = bodyOf(await composed.handlers.serversPage(request('GET', '/servers', '')))
    expect(after).not.toContain('action="/servers/create-policy"')

    // A second click changes nothing.
    const again = await composed.handlers.serversCreatePolicy(createForm())
    expect(again.kind === 'response' && again.status).toBe(409)
    expect(await journaledEdits()).toHaveLength(1)

    // The buttons by each tool now work on the new file.
    const rule = await composed.handlers.serversConfirmRule({
      ...request('POST', '/servers/github/tools/create_issue/confirm', JSON.stringify({ confirm: 'all', expected_hash: hash }), 'application/json'),
      params: { name: 'github', tool: 'create_issue' },
    })
    expect(rule.kind === 'response' && rule.status).toBe(200)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      ...CREATED_POLICY_DOCUMENT,
      servers: { github: { confirmInClient: { create_issue: ['*'] } } },
    })
  })
})
