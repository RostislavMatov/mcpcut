import type { AgentsStore } from '../../agents/store.js'
import { restoreInDeclaredRoot } from '../../files/trash-restore.js'
import { isTrashId } from '../../files/trash-manifest.js'
import type { RootEntry, RootsStore } from '../../files/roots-store.js'
import { rootListCommand } from '../pages/files-commands.js'
import type { GroupsStore } from '../../groups/store.js'
import { TENANT_SETTINGS, type TenantSettings } from '../../tenant/settings.js'
import type { UiSession } from '../auth.js'
import {
  AUDIT_RECORD_DROPPED_WARNING,
  BODY_FORBIDDEN,
  CONTENT_TYPE_HTML,
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_INTERNAL_ERROR,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_OK,
} from '../constants.js'
import { renderFilesPage } from '../pages/files.js'
import { renderNotice } from '../pages/notice.js'
import type { UiHandler, UiRequestContext, UiResult } from '../routes.js'
import { journalAccessEditGuarded } from './access-edit-journal.js'
import type { AccessEditJournalPort, UiAuditSink } from './agents.js'
import { accessOf, auditFiltersOf, auditOf, foldersOf, trashOfRoots } from './files-data.js'
import { untrustedPathText } from '../display-name.js'
import { fieldsOf } from './request-helpers.js'

/**
 * `/files` (ADR-0020 §2, §4, §5): `viewer` reads, only `owner` restores — the
 * route table is the enforcement, this file assumes it. The page is a read
 * over the file module's own stores and the journal; the one write is the
 * trash restore, which goes through the same `restoreInDeclaredRoot` as
 * `mcpcut files trash restore`, then is attributed on the audit sink and
 * journaled as `files.trash.restore` with `via: 'ui'`.
 *
 * The module runs on the owner's own machine (out of scope for hosted, ADR-0020), so on a
 * hosted install both routes answer a notice and touch nothing.
 */

export const HOSTED_MESSAGE = 'The file module runs on your own machine, not on a hosted install.'
export const ROOTS_UNREADABLE_MESSAGE = `The list of folders cannot be read. See why in a terminal: ${rootListCommand()}`
const FILES_HREF = '/files'
const FILES_TRASH_HREF = '/files#trash'

export interface FilesHandlersDeps {
  readonly roots: Pick<RootsStore, 'list'>
  readonly agents: Pick<AgentsStore, 'listAgents'>
  readonly groups: Pick<GroupsStore, 'listGroups'>
  /** Journal directory the audit panel reads. */
  readonly journalDir: string
  readonly clock?: () => number
  readonly tenant?: TenantSettings
  readonly audit?: UiAuditSink
  readonly journalAccessEdit?: AccessEditJournalPort
}

export interface FilesHandlers {
  readonly filesPage: UiHandler
  readonly filesTrashRestore: UiHandler
}

function htmlResult(status: number, body: string): UiResult {
  return { kind: 'response', status, headers: { 'content-type': CONTENT_TYPE_HTML }, body }
}

const FORBIDDEN: UiResult = { kind: 'response', status: HTTP_STATUS_FORBIDDEN, body: BODY_FORBIDDEN }

function refusal(message: string, session: UiSession): UiResult {
  return htmlResult(
    HTTP_STATUS_BAD_REQUEST,
    renderNotice({
      title: 'Files — error',
      message,
      ok: false,
      backHref: FILES_TRASH_HREF,
      backLabel: 'Back to the trash',
      session,
    }),
  )
}

function hostedResult(session: UiSession): UiResult {
  return htmlResult(
    HTTP_STATUS_NOT_FOUND,
    renderNotice({ title: 'Files', message: HOSTED_MESSAGE, ok: false, backHref: '/', backLabel: 'Back to the dashboard', session }),
  )
}

/**
 * The roots file, or undefined when it cannot be read (corrupt, locked, I/O).
 * The cause is not echoed into the browser (see `store-errors.ts`); the
 * notice names the CLI command that prints it.
 */
async function readRoots(roots: Pick<RootsStore, 'list'>): Promise<readonly RootEntry[] | undefined> {
  try {
    return await roots.list()
  } catch {
    return undefined
  }
}

function rootsUnreadable(session: UiSession): UiResult {
  return htmlResult(
    HTTP_STATUS_INTERNAL_ERROR,
    renderNotice({ title: 'Files', message: ROOTS_UNREADABLE_MESSAGE, ok: false, backHref: '/', backLabel: 'Back to the dashboard', session }),
  )
}

export function createFilesHandlers(deps: FilesHandlersDeps): FilesHandlers {
  const isHosted = (deps.tenant ?? TENANT_SETTINGS).isTenant
  const now = (): Date => new Date((deps.clock ?? Date.now)())

  async function filesPage(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    if (isHosted) return hostedResult(session)
    const roots = await readRoots(deps.roots)
    if (roots === undefined) return rootsUnreadable(session)
    const [agents, groups] = await Promise.all([deps.agents.listAgents(), deps.groups.listGroups()])
    const [folders, trash, audit] = await Promise.all([
      foldersOf(roots),
      trashOfRoots(roots),
      auditOf(auditFiltersOf(ctx.query), { dir: deps.journalDir, now: now(), agentNames: agents.map((agent) => agent.name) }),
    ])
    return htmlResult(
      HTTP_STATUS_OK,
      renderFilesPage({ session, canManage: session.role === 'owner', folders, access: accessOf(agents, groups), trash, audit }),
    )
  }

  async function filesTrashRestore(ctx: UiRequestContext): Promise<UiResult> {
    const session = ctx.session
    if (session === undefined) return FORBIDDEN
    if (isHosted) return hostedResult(session)
    const form = fieldsOf(ctx)
    const root = form.root?.trim() ?? ''
    const id = form.id?.trim() ?? ''
    if (root === '' || id === '') return refusal('folder and trash id are required', session)
    if (!isTrashId(id)) return refusal('that is not a trash id: restore from the list below', session)
    const roots = await readRoots(deps.roots)
    if (roots === undefined) return rootsUnreadable(session)
    const declared = roots.map((entry) => entry.path)
    const outcome = await restoreInDeclaredRoot(declared, root, id)
    if (outcome.status === 'no-root') return refusal('that folder is not declared: restore only from a folder listed above', session)
    if (outcome.status === 'failed') return refusal(outcome.message, session)
    deps.audit?.({ actor: 'ui', adminName: session.adminName, action: 'files.trash.restore', target: outcome.target })
    const journaled = await journalAccessEditGuarded(deps.journalAccessEdit, session, {
      action: 'files.trash.restore',
      path: outcome.target,
      trashId: id,
    })
    return htmlResult(
      HTTP_STATUS_OK,
      renderNotice({
        title: 'Files',
        message: `Restored ${untrustedPathText(outcome.target)}. Agents with rights on that folder can use it again.`,
        ok: true,
        backHref: FILES_HREF,
        backLabel: 'Back to files',
        session,
        ...(journaled.written ? {} : { warning: AUDIT_RECORD_DROPPED_WARNING }),
      }),
    )
  }

  return { filesPage, filesTrashRestore }
}
