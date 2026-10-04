import type { FileAuditResult } from '../../files/audit.js'
import type { FileRule } from '../../files/rights.js'
import type { TrashManifest } from '../../files/trash-manifest.js'
import type { UiSession } from '../auth.js'

/** What the Files page renders: plain data the handler gathered, nothing fetched here. */

export interface FolderView {
  readonly path: string
  readonly addedAt: string
  readonly trash: 'ok' | 'missing'
}

/** An agent holding folder rules, and where they come from (`personal`, `from group a, b`). */
export interface AgentAccessView {
  readonly agent: string
  readonly rules: readonly FileRule[]
  readonly origin: string
}

export interface GroupAccessView {
  readonly group: string
  readonly rules: readonly FileRule[]
  readonly members: readonly string[]
}

export interface AccessView {
  readonly agents: readonly AgentAccessView[]
  readonly groups: readonly GroupAccessView[]
  /** Name of the first live agent, to fill the next-step command; absent when there is none. */
  readonly firstAgent?: string
  /** Name of the first group (with or without folder rules). */
  readonly firstGroup?: string
}

export interface TrashRootView {
  readonly root: string
  /** Newest first, already cut to the page size. */
  readonly entries: readonly TrashManifest[]
  /** Entries beyond the page size. */
  readonly more: number
  /** Orphans `listTrash` skipped. */
  readonly skipped: number
  /** The trash could not be read: the message to show instead of entries. */
  readonly problem?: string
}

export interface AuditFilters {
  readonly path: string
  readonly agent: string
  readonly since: string
}

export interface AuditView {
  readonly filters: AuditFilters
  /** Every known agent, for the select. */
  readonly agents: readonly string[]
  /** A filter the page could not use; the panel shows it instead of results. */
  readonly error?: string
  readonly result?: FileAuditResult
  /** The default window and no path or agent: an empty result means "nothing yet". */
  readonly isUnfiltered: boolean
}

export interface FilesView {
  readonly session: UiSession
  readonly canManage: boolean
  readonly folders: readonly FolderView[]
  readonly access: AccessView
  readonly trash: readonly TrashRootView[]
  readonly audit: AuditView
}

/** Trash entries listed per folder before "and N more". */
export const TRASH_PAGE_SIZE = 100
/** Audit rows listed before "the full list". */
export const AUDIT_PAGE_SIZE = 50
/** The audit window when the form names none. */
export const DEFAULT_AUDIT_SINCE = '7d'
/** The CLI's largest audit page, for the "full list" command. */
export const AUDIT_FULL_LIST_LIMIT = 1000
