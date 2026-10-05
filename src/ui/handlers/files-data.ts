import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { AgentRecord } from '../../agents/schema.js'
import { effectiveGrantsOf, type GrantSource } from '../../agents/effective.js'
import { parseSince, queryFileAudit } from '../../files/audit.js'
import { FILES_SERVER_NAME, TRASH_DIR_NAME } from '../../files/constants.js'
import { listTrash } from '../../files/io-trash-admin.js'
import type { RootEntry } from '../../files/roots-store.js'
import type { TrashManifest } from '../../files/trash-manifest.js'
import type { GroupRecord } from '../../groups/schema.js'
import { PATH_ERROR, SINCE_ERROR } from '../pages/files-audit.js'
import {
  AUDIT_PAGE_SIZE,
  DEFAULT_AUDIT_SINCE,
  TRASH_PAGE_SIZE,
  type AccessView,
  type AuditFilters,
  type AuditView,
  type FolderView,
  type TrashRootView,
} from '../pages/files-view.js'

/** Reads for the Files page: every panel's data, gathered from the real stores and the journal. */

async function trashState(root: string): Promise<'ok' | 'missing'> {
  const info = await stat(path.join(root, TRASH_DIR_NAME)).catch(() => null)
  return info?.isDirectory() === true ? 'ok' : 'missing'
}

export async function foldersOf(roots: readonly RootEntry[]): Promise<readonly FolderView[]> {
  return Promise.all(
    roots.map(async (root) => ({ path: root.path, addedAt: root.addedAt, trash: await trashState(root.path) })),
  )
}

function originOf(source: GrantSource | undefined): string {
  if (source === undefined) return 'personal'
  if (source.kind === 'group') return `from group ${source.groups.join(', ')}`
  return source.shadowedGroups.length === 0 ? 'personal' : `personal (overrides group ${source.shadowedGroups.join(', ')})`
}

export function accessOf(agents: readonly AgentRecord[], groups: readonly GroupRecord[]): AccessView {
  const live = agents.filter((agent) => agent.revokedAt === undefined)
  const revoked = new Set(agents.filter((agent) => agent.revokedAt !== undefined).map((agent) => agent.name))
  const holders = live.flatMap((agent) => {
    const effective = effectiveGrantsOf(agent, groups)
    const rules = effective.grants[FILES_SERVER_NAME]?.paths ?? []
    return rules.length === 0
      ? []
      : [{ agent: agent.name, rules, origin: originOf(effective.sources[FILES_SERVER_NAME]) }]
  })
  const groupRules = groups.map((group) => ({
    group: group.name,
    rules: group.grants[FILES_SERVER_NAME]?.paths ?? [],
    members: group.members.map((name) => (revoked.has(name) ? `${name} (revoked)` : name)),
  }))
  const firstAgent = live[0]?.name
  const firstGroup = groups[0]?.name
  return {
    agents: holders,
    groups: groupRules,
    ...(firstAgent !== undefined ? { firstAgent } : {}),
    ...(firstGroup !== undefined ? { firstGroup } : {}),
  }
}

function newestFirst(left: TrashManifest, right: TrashManifest): number {
  if (left.deletedAt !== right.deletedAt) return left.deletedAt < right.deletedAt ? 1 : -1
  return left.id < right.id ? 1 : -1
}

async function trashOf(root: string): Promise<TrashRootView> {
  const listing = await listTrash(root)
  if (!listing.ok) return { root, entries: [], more: 0, skipped: 0, problem: listing.message }
  const sorted = [...listing.value.entries].sort(newestFirst)
  return {
    root,
    entries: sorted.slice(0, TRASH_PAGE_SIZE),
    more: Math.max(0, sorted.length - TRASH_PAGE_SIZE),
    skipped: listing.value.skipped.length,
  }
}

export function trashOfRoots(roots: readonly RootEntry[]): Promise<readonly TrashRootView[]> {
  return Promise.all(roots.map((root) => trashOf(root.path)))
}

/** The audit form's values from the query: `since` defaults, the rest are what was typed. */
export function auditFiltersOf(query: URLSearchParams): AuditFilters {
  const since = (query.get('since') ?? '').trim()
  return {
    path: (query.get('path') ?? '').trim(),
    agent: (query.get('agent') ?? '').trim(),
    since: since === '' ? DEFAULT_AUDIT_SINCE : since,
  }
}

interface AuditContext {
  readonly dir: string
  readonly now: Date
  readonly agentNames: readonly string[]
}

export async function auditOf(filters: AuditFilters, context: AuditContext): Promise<AuditView> {
  const base = {
    filters,
    agents: context.agentNames,
    isUnfiltered: filters.path === '' && filters.agent === '' && filters.since === DEFAULT_AUDIT_SINCE,
  }
  const since = parseSince(filters.since, context.now)
  if (since === null) return { ...base, error: SINCE_ERROR }
  if (filters.path !== '' && !path.isAbsolute(filters.path)) return { ...base, error: PATH_ERROR }
  const result = await queryFileAudit(
    {
      limit: AUDIT_PAGE_SIZE,
      since,
      ...(filters.path !== '' ? { path: filters.path } : {}),
      ...(filters.agent !== '' ? { agent: filters.agent } : {}),
    },
    { dir: context.dir },
  )
  return { ...base, result }
}
