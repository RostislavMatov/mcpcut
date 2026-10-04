import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentRecord } from '../../src/agents/schema.js'
import { createAgentsStore, type AgentsStore } from '../../src/agents/store.js'
import { prepareRoot } from '../../src/files/roots-admin.js'
import { createRootsStore, type RootsStore } from '../../src/files/roots-store.js'
import { moveToTrash } from '../../src/files/io-trash.js'
import { resolveWithinRoots } from '../../src/files/paths.js'
import type { FileOp } from '../../src/files/constants.js'
import { createGroupsStore, type GroupsStore } from '../../src/groups/store.js'
import { createJournalSink } from '../../src/journal/sink.js'
import type { JournalRecord } from '../../src/journal/record.js'
import type { AccessEditInfo } from '../../src/journal/record.js'
import type { UiSession } from '../../src/ui/auth.js'
import type { UiAuditEvent } from '../../src/ui/handlers/agents.js'
import { createFilesHandlers, type FilesHandlers, type FilesHandlersDeps } from '../../src/ui/handlers/files.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'

/** Real stores, a real declared root and a real trash in a temp dir, for the Files page tests. */

export const NOW = Date.parse('2026-10-04T12:00:00.000Z')

export function session(role: UiSession['role'], adminName = 'alice'): UiSession {
  return { adminName, role, csrfToken: 'csrf-token-value-123456' }
}

export function getCtx(sess: UiSession | undefined, query = ''): UiRequestContext {
  return { method: 'GET', path: '/files', params: {}, query: new URLSearchParams(query), session: sess, body: Buffer.alloc(0), headers: {} }
}

export function postCtx(form: Record<string, string>, sess: UiSession | undefined): UiRequestContext {
  return {
    method: 'POST',
    path: '/files/trash/restore',
    params: {},
    query: new URLSearchParams(),
    session: sess,
    body: Buffer.from(new URLSearchParams(form).toString(), 'utf8'),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }
}

export function bodyOf(result: UiResult): string {
  if (result.kind !== 'response') throw new Error('expected a buffered response')
  return String(result.body ?? '')
}

export function statusOf(result: UiResult): number {
  if (result.kind !== 'response') throw new Error('expected a buffered response')
  return result.status
}

export interface FilesFixture {
  readonly base: string
  readonly journalDir: string
  readonly root: string
  readonly roots: RootsStore
  readonly agents: AgentsStore
  readonly groups: GroupsStore
  readonly audit: UiAuditEvent[]
  readonly edits: AccessEditInfo[]
  handlers(overrides?: Partial<FilesHandlersDeps>): FilesHandlers
  /** Writes a file under the root and moves it into the root's trash; returns the trash id. */
  trashFile(relative: string, actor?: string): Promise<string>
  /** Declares the root (its trash is created by `prepareRoot`). */
  declareRoot(): Promise<void>
  grantAgent(name: string, rules: readonly { path: string; ops: readonly FileOp[] }[]): Promise<AgentRecord>
  writeRecords(sessionId: string, records: readonly JournalRecord[]): Promise<void>
  cleanup(): Promise<void>
}

let seq = 0

export function decision(input: {
  ts?: string
  agent?: string
  tool?: string
  outcome?: string
  rule?: string
  payload?: unknown
}): JournalRecord {
  seq += 1
  return {
    id: `01ARZ3NDEKTSV4RRFFQ69H${String(seq).padStart(4, '0')}`,
    ts: input.ts ?? '2026-10-04T10:00:00.000Z',
    sessionId: 'x',
    direction: 'client→server',
    kind: 'decision',
    payload: input.payload ?? {},
    decision: {
      outcome: input.outcome ?? 'allow',
      rule: input.rule ?? 'files: allowed',
      serverName: 'files',
      toolName: input.tool ?? 'read_file',
      toolClass: 'read',
      quarantineState: 'known',
      argsHash: 'h',
      ...(input.agent !== undefined ? { agentName: input.agent } : {}),
    },
  } as unknown as JournalRecord
}

export async function makeFixture(): Promise<FilesFixture> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-ui-files-')))
  const journalDir = join(base, 'state')
  const root = join(base, 'data')
  await mkdir(journalDir, { recursive: true })
  await mkdir(root, { recursive: true })
  const roots = createRootsStore({ journalDir })
  const agents = createAgentsStore({ journalDir })
  const groups = createGroupsStore({ journalDir })
  const audit: UiAuditEvent[] = []
  const edits: AccessEditInfo[] = []
  return {
    base,
    journalDir,
    root,
    roots,
    agents,
    groups,
    audit,
    edits,
    handlers: (overrides = {}) =>
      createFilesHandlers({
        roots,
        agents,
        groups,
        journalDir,
        clock: () => NOW,
        audit: (event) => audit.push(event),
        journalAccessEdit: async (info) => {
          edits.push(info)
          return { written: true }
        },
        ...overrides,
      }),
    async declareRoot() {
      const prepared = await prepareRoot(root)
      if (!prepared.ok) throw new Error(prepared.message)
      await roots.add(prepared.path)
    },
    async trashFile(relative, actor = 'bot') {
      await mkdir(dirname(join(root, relative)), { recursive: true })
      await writeFile(join(root, relative), 'content')
      const resolved = await resolveWithinRoots(join(root, relative), [root])
      if (!resolved.ok) throw new Error(resolved.message)
      const moved = await moveToTrash(resolved.path, actor)
      if (!moved.ok) throw new Error(moved.message)
      return moved.value.id
    },
    async grantAgent(name, rules) {
      await agents.createAgent(name)
      return agents.setServerGrant(name, 'files', { tools: '*', paths: rules.map((rule) => ({ path: rule.path, ops: [...rule.ops] })) })
    },
    async writeRecords(sessionId, records) {
      const sink = createJournalSink(sessionId, { dir: journalDir })
      for (const entry of records) sink.write({ ...entry, sessionId })
      await sink.close()
    },
    cleanup: () => rm(base, { recursive: true, force: true }),
  }
}
