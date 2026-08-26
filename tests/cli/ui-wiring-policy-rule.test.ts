import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
 * Wiring smoke for the per-tool rule edit (plan policy-tool-rules-ui wave 4,
 * corrected 2026-08-26): the production handler map from `composeUi` against
 * a REAL temp journal dir with a real `policy.json`. A POST rewrites the file
 * the composed process itself resolved (`resolvePolicyEditTarget` over the
 * same env/cwd the view uses), the page's view reflects it, a stale CAS token
 * is refused, the audit line reaches stderr and the `policy-edit` record
 * lands in `journal.db`.
 */

const OWNER = { adminName: 'alice', role: 'owner' as const, csrfToken: 'csrf' }

let dir = ''
let stderr: string[] = []
let composed: UiComposition
const opened: UiComposition[] = []
const tempDirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(made)
  return made
}

/** One composed UI over a real state dir, started from a given working directory. */
async function composeOver(journalDir: string, cwd: string): Promise<UiComposition> {
  const registry = createRegistryStore(journalDir)
  await registry.addServer({ name: 'github', transport: 'stdio', command: 'gh-mcp' })
  const composition = composeUi({
    journalDir,
    approvalsBaseDir: join(journalDir, 'approvals'),
    inventoryStorePath: join(journalDir, INVENTORY_FILE_NAME),
    adminStore: createAdminStore({ journalDir }),
    agents: createAgentsStore({ journalDir }),
    registry,
    vault: createVaultStore({ journalDir }),
    hub: createEventHub(),
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    env: {},
    cwd,
  })
  opened.push(composition)
  return composition
}

beforeEach(async () => {
  stderr = []
  dir = await tempDir('mcp-ui-wiring-policy-')
  await writeFile(join(dir, POLICY_FILE_NAME), '{"version":1}\n', 'utf8')
  composed = await composeOver(dir, dir)
})

afterEach(async () => {
  for (const composition of opened.splice(0)) await composition.closeProbes()
  for (const made of tempDirs.splice(0)) await rm(made, { recursive: true, force: true })
})

async function hashOf(path: string): Promise<string> {
  const loaded = await loadPolicy({ explicitPath: path, cwd: dir })
  if (loaded.status !== 'loaded') throw new Error(`policy not loadable: ${JSON.stringify(loaded)}`)
  return policyHashOf(loaded.policy)
}

async function currentHash(): Promise<string> {
  return hashOf(join(dir, POLICY_FILE_NAME))
}

function getServers(): UiRequestContext {
  return {
    method: 'GET',
    path: '/servers',
    params: {},
    query: new URLSearchParams(),
    session: OWNER,
    body: Buffer.alloc(0),
    headers: {},
  }
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

describe('composeUi: the rule handler writes the resolved policy file with CAS', () => {
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
    const page = await composed.handlers.serversPage(getServers())
    const html = bodyOf(page)
    expect(html).toContain(`policy · <code>${join(dir, POLICY_FILE_NAME)}</code>`)
    expect(html).toContain(`<span class="num" data-live-text="policy-hash">${(await currentHash()).slice(0, 8)}</span>`)
    expect(html).toContain('every entry point reads this file')
    // The inventory has no tools yet, so no rule rows; the region is there for the settle.
    expect(html).toContain('data-live-region="server-tools:github"')
  })

  /**
   * Correction 2026-08-26: the edit follows the load order instead of a
   * hard-wired path. With the process cwd on the state dir, the nested
   * `.mcp-journal/policy.json` is what BOTH this process and `connect` load —
   * so that is the file the edit lands in, and the flat one is left alone.
   */
  test('the file the process itself loaded is the file edited, not a hard-wired one', async () => {
    const nestedPath = join(dir, '.mcp-journal', POLICY_FILE_NAME)
    await mkdir(join(dir, '.mcp-journal'), { recursive: true })
    await writeFile(nestedPath, '{"version":1}\n', 'utf8')
    const nestedHash = await hashOf(nestedPath)

    const result = await composed.handlers.serversToolRule(postRule('deny', nestedHash))

    expect(result.kind === 'response' && result.status).toBe(200)
    expect(JSON.parse(await readFile(nestedPath, 'utf8'))).toEqual({
      version: 1,
      servers: { github: { tools: { create_issue: 'deny' } } },
    })
    expect(JSON.parse(await readFile(join(dir, POLICY_FILE_NAME), 'utf8'))).toEqual({ version: 1 })
    const edits = await journaledEdits()
    expect(edits).toHaveLength(1)
    expect(edits[0]).toMatchObject({ sourcePath: nestedPath })
  })

  /**
   * The live install that forced the correction: the state dir has NO policy,
   * the operator's cwd has a project one, and the plane enforces that project
   * file. The card must be editable and must say `connect` is not covered.
   */
  test('a project-level policy with an empty state dir: editable, and the card states connect is uncovered', async () => {
    const stateDir = await tempDir('mcp-ui-wiring-policy-state-')
    const workDir = await tempDir('mcp-ui-wiring-policy-cwd-')
    const projectPath = join(workDir, '.mcp-journal', POLICY_FILE_NAME)
    await mkdir(join(workDir, '.mcp-journal'), { recursive: true })
    await writeFile(projectPath, '{"version":1}\n', 'utf8')
    await writeFile(
      join(stateDir, INVENTORY_FILE_NAME),
      JSON.stringify({
        version: 1,
        servers: { github: { approved: { create_issue: { schemaHash: 'h', approvedAt: '2026-08-01T00:00:00.000Z' } }, quarantined: {} } },
      }),
      'utf8',
    )
    const other = await composeOver(stateDir, workDir)

    const page = await other.handlers.serversPage(getServers())
    const html = bodyOf(page)
    expect(html).toContain(`policy · <code>${projectPath}</code>`)
    expect(html).toContain('ui/wrap/serve read this file; connect sessions have no policy right now')
    expect(html).toContain('data-action="/servers/github/tools/create_issue/rule"')
    expect(html).not.toContain('no policy — enforcement off')

    const result = await other.handlers.serversToolRule(postRule('deny', await hashOf(projectPath)))
    expect(result.kind === 'response' && result.status).toBe(200)
    expect(JSON.parse(await readFile(projectPath, 'utf8'))).toEqual({
      version: 1,
      servers: { github: { tools: { create_issue: 'deny' } } },
    })
  })
})
