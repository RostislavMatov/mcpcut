import { TRASH_DIR_NAME, TRASH_RETENTION_DAYS } from '../../files/constants.js'
import type { TrashManifest } from '../../files/trash-manifest.js'
import { html, join, type Html } from '../html.js'
import { csrfField } from './csrf-field.js'
import { renderCommandBlock, trashListCommand, trashPurgeCommand } from './files-commands.js'
import type { FilesView, TrashRootView } from './files-view.js'

/** Panel 3 of the Files page: what agents deleted, kept for the retention window, and the owner's Restore button. */

function restoreCell(view: FilesView, root: string, entry: TrashManifest): Html {
  if (!view.canManage) return html`<span class="small dim">An owner restores.</span>`
  return html`<form method="post" action="/files/trash/restore" class="inline">
    ${csrfField(view.session.csrfToken)}
    <input type="hidden" name="root" value="${root}">
    <input type="hidden" name="id" value="${entry.id}">
    <button type="submit" class="secondary">Restore</button>
  </form>`
}

function entryRow(view: FilesView, root: string, entry: TrashManifest): Html {
  return html`<tr>
    <td><code>${entry.relative}</code></td>
    <td>${entry.kind === 'directory' ? 'folder' : 'file'}</td>
    <td class="num">${String(entry.size)} B</td>
    <td class="num">${entry.deletedAt}</td>
    <td>${entry.deletedBy}</td>
    <td>${restoreCell(view, root, entry)}</td>
  </tr>`
}

function rootNotes(root: TrashRootView): Html {
  const more =
    root.more === 0
      ? html``
      : html`<p class="small dim">and ${String(root.more)} more — <code>${trashListCommand(root.root)}</code></p>`
  const orphans =
    root.skipped === 0
      ? html``
      : html`<p class="small dim">${String(root.skipped)} unreadable ${root.skipped === 1 ? 'entry' : 'entries'} skipped: remove by hand inside <code>${root.root}/${TRASH_DIR_NAME}</code>.</p>`
  return html`${more}${orphans}`
}

function rootBlock(view: FilesView, root: TrashRootView): Html {
  const table =
    root.entries.length === 0
      ? html``
      : html`<div class="table-wrap"><table class="fl-table">
    <thead><tr><th>What</th><th>Kind</th><th>Size</th><th>Deleted</th><th>By</th><th></th></tr></thead>
    <tbody>${join(root.entries.map((entry) => entryRow(view, root.root, entry)))}</tbody>
  </table></div>`
  const problem = root.problem === undefined ? html`` : html`<p class="small dim">${root.problem}</p>`
  return html`<div class="fl-root"><h3 class="small"><code>${root.root}</code></h3>${problem}${table}${rootNotes(root)}</div>`
}

function purgeFooter(view: FilesView): Html {
  const first = view.folders[0]
  const keep = html`<p class="small dim">Kept ${String(TRASH_RETENTION_DAYS)} days, then removed automatically.</p>`
  if (!view.canManage || first === undefined) return keep
  return html`${keep}${renderCommandBlock(trashPurgeCommand(first.path, TRASH_RETENTION_DAYS))}`
}

export function renderTrashPanel(view: FilesView): Html {
  const isEmpty = view.trash.every((root) => root.entries.length === 0 && root.skipped === 0 && root.problem === undefined)
  const body = isEmpty
    ? html`<p class="empty">Nothing in the trash. What agents delete stays here for ${String(TRASH_RETENTION_DAYS)} days.</p>`
    : join(view.trash.filter((root) => root.entries.length > 0 || root.skipped > 0 || root.problem !== undefined).map((root) => rootBlock(view, root)))
  return html`<section class="panel fl-panel" id="trash" aria-label="Trash">
    <div class="panel-hd"><h2>Trash</h2></div>
    <div class="panel-bd">${body}${purgeFooter(view)}</div>
  </section>`
}
