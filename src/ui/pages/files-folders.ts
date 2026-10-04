import { html, join, type Html } from '../html.js'
import { rootAddCommand, renderCommandBlock } from './files-commands.js'
import type { FolderView } from './files-view.js'

/** Panel 1 of the Files page: the folders agents may reach. */

function folderRow(folder: FolderView): Html {
  const trash =
    folder.trash === 'ok' ? html`<span class="pill pill-on">trash ok</span>` : html`<span class="pill pill-alert">trash missing</span>`
  return html`<tr><td><code>${folder.path}</code></td><td>${trash}</td><td class="num">${folder.addedAt}</td></tr>`
}

function noFolders(canManage: boolean): Html {
  if (!canManage) return html`<p class="empty">No folders yet. An owner declares them.</p>`
  return html`<p class="empty">No folders yet. Declare one agents may reach:</p>${renderCommandBlock(rootAddCommand())}`
}

/** A missing trash is repaired by declaring the root again; otherwise the next step is one more folder. */
function nextStep(folders: readonly FolderView[], canManage: boolean): Html {
  if (!canManage) return html`<p class="small dim">An owner declares folders.</p>`
  const broken = folders.find((folder) => folder.trash === 'missing')
  if (broken !== undefined) {
    return html`<p class="small dim">A trash is missing. Recreate it:</p>${renderCommandBlock(rootAddCommand(broken.path))}`
  }
  return html`<p class="small dim">Declare another folder:</p>${renderCommandBlock(rootAddCommand())}`
}

export function renderFoldersPanel(folders: readonly FolderView[], canManage: boolean): Html {
  const body =
    folders.length === 0
      ? noFolders(canManage)
      : html`<div class="table-wrap"><table class="fl-table">
    <thead><tr><th>Folder</th><th>Trash</th><th>Added</th></tr></thead>
    <tbody>${join(folders.map(folderRow))}</tbody>
  </table></div>${nextStep(folders, canManage)}`
  return html`<section class="panel fl-panel" id="folders" aria-label="Folders">
    <div class="panel-hd"><h2>Folders</h2><span class="small dim num">${String(folders.length)} declared</span></div>
    <div class="panel-bd">${body}</div>
  </section>`
}
