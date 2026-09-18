import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createAgentsStore } from '../../src/agents/store.js'
import { createGroupsStore } from '../../src/groups/store.js'
import { ACCESS_EDIT_SESSION_ID } from '../../src/journal/access-edit-record.js'
import { readSessionWithStats } from '../../src/journal/reader.js'
import type { AccessEditInfo } from '../../src/journal/record.js'
import { createRegistryStore } from '../../src/registry/store.js'
import { createVaultStore } from '../../src/vault/store.js'
import { AUDIT_RECORD_DROPPED_WARNING } from '../../src/ui/constants.js'
import type { AccessEditJournalPort } from '../../src/ui/handlers/agents.js'
import { createServersHandlers, type ServersHandlers } from '../../src/ui/handlers/servers.js'
import type { ServerStatusPort } from '../../src/ui/handlers/servers-status.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'
import { startUiHarness, type UiTestHarness } from './harness.js'

/**
 * `POST /servers/add` and `POST /servers/edit` leave an `access-edit` journal
 * record (owner decision 2026-09-18). Deciding WHICH process the plane may
 * launch is the same category of fact as removing one, which has been
 * journalled since M5.5 п.2 — and the stderr audit line alone never reaches an
 * exported report. A record that could not be written is shown on the success
 * page (audit F1/H4), never turned into a 500: the registry write has landed.
 */

interface Harness {
  readonly registry: ReturnType<typeof createRegistryStore>
  /** Every `access-edit` the handlers handed to the journal port. */
  readonly accessEdits: AccessEditInfo[]
  /** Names the registration probe was started for, in order. */
  readonly probed: string[]
  /** How many records the journal port had seen when each probe RAN. */
  readonly recordsAtProbe: number[]
  /** Handlers over the same stores; `journal` replaces the recording port. */
  handlers(journal?: AccessEditJournalPort | null): ServersHandlers
  dispose(): void
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-ui-servers-journal-'))
  const registry = createRegistryStore(dir)
  const agents = createAgentsStore({ journalDir: dir })
  const groups = createGroupsStore({ journalDir: dir })
  const vault = createVaultStore({ journalDir: dir })
  const accessEdits: AccessEditInfo[] = []
  const probed: string[] = []
  const recordsAtProbe: number[] = []
  const probes: ServerStatusPort = {
    ensureFresh: async () => undefined,
    probeNow: async (name) => {
      probed.push(name)
      recordsAtProbe.push(accessEdits.length)
      return { status: 'never-checked' }
    },
    listStatuses: async () => ({}),
    lastSuccessfulActivity: async () => null,
  }
  const recording: AccessEditJournalPort = async (info) => {
    accessEdits.push(info)
    return { written: true }
  }
  return {
    registry,
    accessEdits,
    probed,
    recordsAtProbe,
    // `null` = no port wired at all; `undefined` = the recording one.
    handlers: (journal) => {
      const port = journal === undefined ? recording : journal
      return createServersHandlers({
        registry,
        agents,
        groups,
        vault,
        probes,
        ...(port !== null ? { journalAccessEdit: port } : {}),
      })
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const OWNER = { adminName: 'alice', role: 'owner' as const, csrfToken: 'csrf-token-xyz' }

function formPost(
  pairs: Record<string, string>,
  path: string,
  session: UiRequestContext['session'] = OWNER,
): UiRequestContext {
  return {
    method: 'POST',
    path,
    params: {},
    query: new URLSearchParams(),
    ...(session !== undefined ? { session } : {}),
    body: Buffer.from(new URLSearchParams(pairs).toString(), 'utf8'),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }
}

function asResponse(result: UiResult): Extract<UiResult, { kind: 'response' }> {
  if (result.kind !== 'response') throw new Error('expected a buffered response')
  return result
}

const ADD_FIELDS = { csrf_token: OWNER.csrfToken, name: 'notes', transport: 'stdio', command: 'node' }
const EDIT_FIELDS = { csrf_token: OWNER.csrfToken, original: 'notes', transport: 'stdio', command: 'deno' }

const DROPPING: AccessEditJournalPort = async () => ({ written: false })
const THROWING: AccessEditJournalPort = async () => {
  throw new Error('journal unreachable')
}

let h: Harness | null = null
afterEach(() => {
  h?.dispose()
  h = null
})

describe('serversAdd — the registration is journalled as an access edit', () => {
  test('a confirmed add writes one server.add record naming the server and the signed-in admin', async () => {
    h = makeHarness()

    const res = asResponse(
      await h.handlers().serversAdd(formPost({ ...ADD_FIELDS, confirm: 'true' }, '/servers/add')),
    )

    expect(res.status).toBe(303)
    expect(res.headers?.location).toBe('/servers')
    expect(h.accessEdits).toEqual([
      { actor: { adminName: 'alice', role: 'owner', via: 'ui' }, action: 'server.add', server: 'notes' },
    ])
  })

  test('the record of WHO registered is written before the registration probe runs the command', async () => {
    h = makeHarness()
    const harness = h

    await h.handlers().serversAdd(formPost({ ...ADD_FIELDS, confirm: 'true' }, '/servers/add'))

    await vi.waitFor(() => expect(harness.probed).toEqual(['notes']))
    expect(h.recordsAtProbe).toEqual([1])
  })

  test('the interstitial writes nothing: no record until the admin confirmed', async () => {
    h = makeHarness()

    const res = asResponse(await h.handlers().serversAdd(formPost(ADD_FIELDS, '/servers/add')))

    expect(res.status).toBe(200)
    expect(h.accessEdits).toHaveLength(0)
    expect(h.probed).toHaveLength(0)
  })

  test('a registration the schema rejects writes no record', async () => {
    h = makeHarness()
    const { command: _dropped, ...withoutCommand } = ADD_FIELDS

    const res = asResponse(
      await h.handlers().serversAdd(formPost({ ...withoutCommand, confirm: 'true' }, '/servers/add')),
    )

    expect(res.status).toBe(400)
    expect(h.accessEdits).toHaveLength(0)
  })

  test('a name the registry already holds writes no record — nothing was registered', async () => {
    h = makeHarness()
    await h.registry.addServer({ name: 'notes', transport: 'stdio', command: 'uvx' })

    const res = asResponse(
      await h.handlers().serversAdd(formPost({ ...ADD_FIELDS, confirm: 'true' }, '/servers/add')),
    )

    expect(res.status).toBe(400)
    expect(h.accessEdits).toHaveLength(0)
    expect(h.probed).toHaveLength(0)
  })

  test('a dropped record → the server is registered, a 200 notice carries the warning, the probe still starts', async () => {
    h = makeHarness()
    const harness = h

    const res = asResponse(
      await h.handlers(DROPPING).serversAdd(formPost({ ...ADD_FIELDS, confirm: 'true' }, '/servers/add')),
    )

    expect(res.status).toBe(200)
    expect(String(res.body ?? '')).toContain(AUDIT_RECORD_DROPPED_WARNING)
    expect(String(res.body ?? '')).toContain('class="notice ok')
    expect(String(res.body ?? '')).toContain('registered notes')
    expect(await h.registry.getServer('notes')).toBeDefined()
    await vi.waitFor(() => expect(harness.probed).toEqual(['notes']))
  })

  test('a journal port that throws cannot turn a completed registration into a 500 — it is a dropped record', async () => {
    h = makeHarness()
    const harness = h

    const res = asResponse(
      await h.handlers(THROWING).serversAdd(formPost({ ...ADD_FIELDS, confirm: 'true' }, '/servers/add')),
    )

    expect(res.status).toBe(200)
    expect(String(res.body ?? '')).toContain(AUDIT_RECORD_DROPPED_WARNING)
    expect(await h.registry.getServer('notes')).toBeDefined()
    await vi.waitFor(() => expect(harness.probed).toEqual(['notes']))
  })

  test('no journal port at all is the composition root\'s choice, not a lost record: the plain 303', async () => {
    h = makeHarness()

    const res = asResponse(
      await h.handlers(null).serversAdd(formPost({ ...ADD_FIELDS, confirm: 'true' }, '/servers/add')),
    )

    expect(res.status).toBe(303)
  })

  test('a session-less context keeps the redirect rather than a page under a fabricated identity', async () => {
    h = makeHarness()
    const ctx: UiRequestContext = (() => {
      const { session: _session, ...rest } = formPost({ ...ADD_FIELDS, confirm: 'true' }, '/servers/add')
      return rest
    })()

    const res = asResponse(await h.handlers(DROPPING).serversAdd(ctx))

    expect(res.status).toBe(303)
    expect(await h.registry.getServer('notes')).toBeDefined()
  })
})

describe('serversEdit — a changed definition is journalled as an access edit', () => {
  test('a confirmed edit writes one server.update record naming the server and the signed-in admin', async () => {
    h = makeHarness()
    await h.registry.addServer({ name: 'notes', transport: 'stdio', command: 'node' })

    const res = asResponse(
      await h.handlers().serversEdit(formPost({ ...EDIT_FIELDS, confirm: 'true' }, '/servers/edit')),
    )

    expect(res.status).toBe(303)
    expect((await h.registry.getServer('notes'))?.command).toBe('deno')
    expect(h.accessEdits).toEqual([
      { actor: { adminName: 'alice', role: 'owner', via: 'ui' }, action: 'server.update', server: 'notes' },
    ])
  })

  test('the record names the ORIGINAL server, whatever name the form posted', async () => {
    h = makeHarness()
    await h.registry.addServer({ name: 'notes', transport: 'stdio', command: 'node' })

    await h
      .handlers()
      .serversEdit(formPost({ ...EDIT_FIELDS, name: 'hijacked', confirm: 'true' }, '/servers/edit'))

    expect(h.accessEdits.map((edit) => edit.server)).toEqual(['notes'])
  })

  test('the interstitial and a rejected edit write nothing', async () => {
    h = makeHarness()
    await h.registry.addServer({ name: 'notes', transport: 'stdio', command: 'node' })
    const { command: _dropped, ...withoutCommand } = EDIT_FIELDS

    const interstitial = asResponse(await h.handlers().serversEdit(formPost(EDIT_FIELDS, '/servers/edit')))
    const rejected = asResponse(
      await h.handlers().serversEdit(formPost({ ...withoutCommand, confirm: 'true' }, '/servers/edit')),
    )

    expect(interstitial.status).toBe(200)
    expect(rejected.status).toBe(400)
    expect(h.accessEdits).toHaveLength(0)
  })

  test('an edit of a server the registry does not hold is a 404 and writes nothing', async () => {
    h = makeHarness()

    const res = asResponse(
      await h.handlers().serversEdit(formPost({ ...EDIT_FIELDS, confirm: 'true' }, '/servers/edit')),
    )

    expect(res.status).toBe(404)
    expect(h.accessEdits).toHaveLength(0)
  })

  test('a dropped record → the edit stands, and a 200 notice carries the warning instead of the 303', async () => {
    h = makeHarness()
    await h.registry.addServer({ name: 'notes', transport: 'stdio', command: 'node' })

    const res = asResponse(
      await h.handlers(DROPPING).serversEdit(formPost({ ...EDIT_FIELDS, confirm: 'true' }, '/servers/edit')),
    )

    expect(res.status).toBe(200)
    expect(String(res.body ?? '')).toContain(AUDIT_RECORD_DROPPED_WARNING)
    expect(String(res.body ?? '')).toContain('class="notice ok')
    expect(String(res.body ?? '')).toContain('updated notes')
    expect((await h.registry.getServer('notes'))?.command).toBe('deno')
  })

  test('a journal port that throws cannot turn a completed edit into a 500 — it is a dropped record', async () => {
    h = makeHarness()
    await h.registry.addServer({ name: 'notes', transport: 'stdio', command: 'node' })

    const res = asResponse(
      await h.handlers(THROWING).serversEdit(formPost({ ...EDIT_FIELDS, confirm: 'true' }, '/servers/edit')),
    )

    expect(res.status).toBe(200)
    expect(String(res.body ?? '')).toContain(AUDIT_RECORD_DROPPED_WARNING)
    expect((await h.registry.getServer('notes'))?.command).toBe('deno')
  })
})

// ---------------------------------------------------------------------------
// Composed UI over a real socket: the port is WIRED, the record reaches the journal
// ---------------------------------------------------------------------------

const FAKE_SERVER_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/fake-server.mjs')

describe('composed UI: add and edit reach the real journal', () => {
  let started: UiTestHarness | null = null
  let composedDir: string | null = null

  afterEach(async () => {
    await started?.stop()
    started = null
    if (composedDir !== null) rmSync(composedDir, { recursive: true, force: true })
    composedDir = null
  })

  test('an owner\'s add then edit leave server.add and server.update under the access-edit session', async () => {
    composedDir = mkdtempSync(join(tmpdir(), 'mcp-ui-servers-journal-composed-'))
    started = await startUiHarness({ journalDir: composedDir })
    const owner = await started.login('ui-owner')
    // A real, harmless command: the registration probe RUNS what is registered.
    const definition = { transport: 'stdio', command: process.execPath, args: FAKE_SERVER_FIXTURE }

    const added = await owner.post('/servers/add', { ...definition, name: 'fake', confirm: 'true' })
    const edited = await owner.post('/servers/edit', {
      ...definition,
      original: 'fake',
      env: 'MODE=quiet',
      confirm: 'true',
    })

    expect(added.status).toBe(303)
    expect(edited.status).toBe(303)
    const stored = await readSessionWithStats(ACCESS_EDIT_SESSION_ID, { dir: composedDir })
    expect(stored.records.map((record) => record.payload)).toEqual([
      { actor: { adminName: 'ui-owner', role: 'owner', via: 'ui' }, action: 'server.add', server: 'fake' },
      { actor: { adminName: 'ui-owner', role: 'owner', via: 'ui' }, action: 'server.update', server: 'fake' },
    ])
  }, 20_000)
})
