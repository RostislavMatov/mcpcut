import type { FileAuditActor, FileAuditEntry } from '../../files/audit.js'
import { html, join, safeUrl, type Html } from '../html.js'
import { sessionHref } from './journal-parts.js'
import { renderUntrustedPath } from '../display-name.js'
import {
  auditCommand,
  grantCommand,
  renderCommandBlock,
  rootAddCommand,
} from './files-commands.js'
import { AUDIT_FULL_LIST_LIMIT, AUDIT_PAGE_SIZE, type AuditView, type FilesView } from './files-view.js'

/** Panel 4 of the Files page: who touched what, a GET form over `queryFileAudit`. */

export const SINCE_ERROR =
  'Since takes a day as YYYY-MM-DD or an age as <N>d (1 to 3650 days), e.g. 7d.'
export const PATH_ERROR = 'Path must be absolute, e.g. /home/me/project, or empty for every folder.'

function actorText(actor: FileAuditActor): string {
  return actor.kind === 'agent' ? (actor.name ?? '-') : `admin ${actor.name} (${actor.via})`
}

function pathsCell(paths: readonly string[]): Html {
  return join(paths.map(renderUntrustedPath), html` → `)
}

function entryRow(entry: FileAuditEntry): Html {
  const isAllow = entry.outcome === 'allow'
  const rule = entry.rule !== null && !isAllow ? entry.rule : ''
  return html`<tr>
    <td class="num">${entry.ts}</td>
    <td>${actorText(entry.actor)}</td>
    <td>${entry.action}${entry.subject === null ? '' : ` for ${entry.subject.kind} ${entry.subject.name}`}</td>
    <td>${entry.outcome ?? ''}</td>
    <td><code>${pathsCell(entry.paths)}</code></td>
    <td class="small dim">${rule}</td>
    <td><a href="${safeUrl(sessionHref(entry.sessionId))}">session</a></td>
  </tr>`
}

function agentOptions(audit: AuditView): Html {
  const options = audit.agents.map(
    (name) => html`<option value="${name}"${name === audit.filters.agent ? html` selected` : html``}>${name}</option>`,
  )
  return html`<option value="">any</option>${join(options)}`
}

function filterForm(audit: AuditView): Html {
  return html`<form method="get" action="${safeUrl('/files#audit')}" class="fl-filters">
    <label><span>Path</span><input type="text" name="path" value="${audit.filters.path}" placeholder="any folder"></label>
    <label><span>Agent</span><select name="agent">${agentOptions(audit)}</select></label>
    <label><span>Since</span><input type="text" name="since" value="${audit.filters.since}" placeholder="7d or YYYY-MM-DD"></label>
    <button type="submit" class="secondary">Search</button>
  </form>`
}

/** The three empty cases of `files audit`: no folders, filters match nothing, nothing recorded yet. */
function emptyResult(view: FilesView): Html {
  if (view.folders.length === 0) {
    return html`<p class="empty">No file operations recorded.${view.canManage ? html` Declare a folder first:` : html` An owner declares a folder first.`}</p>${view.canManage ? renderCommandBlock(rootAddCommand()) : html``}`
  }
  if (!view.audit.isUnfiltered) {
    return html`<p class="empty">No file operations match these filters — drop one or widen Since.</p>`
  }
  if (!view.canManage) {
    return html`<p class="empty">No file operations recorded yet. An owner gives an agent access.</p>`
  }
  const command = grantCommand(view.access.firstAgent, view.folders[0]?.path)
  return html`<p class="empty">No file operations recorded yet. Agents reach folders through connect — give one access:</p>${renderCommandBlock(command)}`
}

function resultNotes(audit: AuditView): Html {
  const result = audit.result
  if (result === undefined) return html``
  const more = result.hasMore
    ? html`<p class="small dim">Showing the newest ${String(AUDIT_PAGE_SIZE)} — the full list:</p>${renderCommandBlock(auditCommand(audit.filters, AUDIT_FULL_LIST_LIMIT))}`
    : html``
  const truncated = result.truncated
    ? html`<p class="small dim">Searched only the newest sessions — narrow the filters.</p>`
    : html``
  return html`${more}${truncated}`
}

function resultTable(view: FilesView): Html {
  const { audit } = view
  if (audit.error !== undefined) return html`<p class="empty" role="alert">${audit.error}</p>`
  const entries = audit.result?.entries ?? []
  if (entries.length === 0) return emptyResult(view)
  return html`<div class="table-wrap"><table class="fl-table">
    <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Outcome</th><th>Path</th><th>Rule</th><th></th></tr></thead>
    <tbody>${join(entries.map(entryRow))}</tbody>
  </table></div>`
}

function sourceNotice(audit: AuditView): Html {
  return audit.notice === undefined ? html`` : html`<p class="small dim" role="status">${audit.notice}</p>`
}

export function renderAuditPanel(view: FilesView): Html {
  return html`<section class="panel fl-panel" id="audit" aria-label="Who touched what">
    <div class="panel-hd"><h2>Who touched what</h2></div>
    <div class="panel-bd">${filterForm(view.audit)}${sourceNotice(view.audit)}${resultTable(view)}${resultNotes(view.audit)}</div>
  </section>`
}
