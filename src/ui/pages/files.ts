import { html } from '../html.js'
import { renderLayout } from './layout.js'
import { renderAccessPanel } from './files-access.js'
import { renderAuditPanel } from './files-audit.js'
import { renderFoldersPanel } from './files-folders.js'
import { renderTrashPanel } from './files-trash.js'
import type { FilesView } from './files-view.js'

/**
 * The `/files` page (ADR-0020 §2, §4, §5): one page, four panels in the order
 * a person works through them — the folders agents may reach, who has which
 * rule, what was deleted, and who touched what. Pure view layer: every value
 * (paths, agent names, manifests) comes off disk and goes through `html`.
 * Native forms only (a GET for the audit filters, a POST for Restore), so
 * nothing needs a script. The commands are shown, not run: granting is the
 * CLI's `files grant`, which the page names with the real values filled in.
 */

function metaOf(view: FilesView): string {
  const folders = view.folders.length
  return `${String(folders)} ${folders === 1 ? 'folder' : 'folders'}`
}

export function renderFilesPage(view: FilesView): string {
  const content = html`<div class="fl-page">
  <h1>Files</h1>
  ${renderFoldersPanel(view.folders, view.canManage)}
  ${renderAccessPanel(view)}
  ${renderTrashPanel(view)}
  ${renderAuditPanel(view)}
  </div>`
  return renderLayout({
    title: 'Files',
    content,
    csrfToken: view.session.csrfToken,
    currentAdmin: { name: view.session.adminName, role: view.session.role },
    activeNav: 'files',
    navMeta: metaOf(view),
  })
}
