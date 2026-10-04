import type { FileRule } from '../../files/rights.js'
import { html, join, safeUrl, type Html } from '../html.js'
import { grantCommand, groupGrantCommand, renderCommandBlock, revokeCommand } from './files-commands.js'
import type { AccessView, FilesView } from './files-view.js'

/** Panel 2 of the Files page: which agents and groups hold which folder rules. */

function opsText(rule: FileRule): string {
  return rule.ops.length === 0 ? 'no access (cut out)' : rule.ops.join(', ')
}

function ruleList(rules: readonly FileRule[]): Html {
  return html`<ul class="fl-rules">${join(rules.map((rule) => html`<li><code>${rule.path}</code>: ${opsText(rule)}</li>`))}</ul>`
}

function accessTable(access: AccessView): Html {
  const agentRows = access.agents.map(
    (entry) => html`<tr><td>${entry.agent}</td><td>${ruleList(entry.rules)}</td><td class="small dim">${entry.origin}</td></tr>`,
  )
  const groupRows = access.groups
    .filter((entry) => entry.rules.length > 0)
    .map((entry) => {
      const members = entry.members.length === 0 ? 'no members yet' : entry.members.join(', ')
      return html`<tr><td>group ${entry.group}</td><td>${ruleList(entry.rules)}</td><td class="small dim">members: ${members}</td></tr>`
    })
  if (agentRows.length === 0 && groupRows.length === 0) {
    return html`<p class="empty">No agent or group has folder rules yet.</p>`
  }
  return html`<div class="table-wrap"><table class="fl-table">
    <thead><tr><th>Who</th><th>Rules</th><th>Comes from</th></tr></thead>
    <tbody>${join([...agentRows, ...groupRows])}</tbody>
  </table></div>`
}

/** The ready commands for an owner: grant to the first agent and folder, to a group, and revoke an existing rule. */
function ownerCommands(view: FilesView): Html {
  const folder = view.folders[0]?.path
  const { access } = view
  const first = access.agents[0]
  const group = access.firstGroup
  return html`${renderCommandBlock(grantCommand(access.firstAgent, folder))}
    ${group === undefined ? html`` : renderCommandBlock(groupGrantCommand(group, folder))}
    ${first === undefined || first.rules[0] === undefined ? html`` : renderCommandBlock(revokeCommand(first.agent, first.rules[0].path))}`
}

/** The section ends with its next step: create an agent, declare a folder, or the commands an owner runs. */
function nextStep(view: FilesView): Html {
  if (!view.canManage) return html`<p class="small dim">An owner gives access.</p>`
  if (view.access.firstAgent === undefined) {
    return html`<p class="small dim"><a href="${safeUrl('/agents')}">Create an agent first</a>, then give it a folder.</p>`
  }
  if (view.folders.length === 0) {
    return html`<p class="small dim"><a href="${safeUrl('#folders')}">Declare a folder first</a>, then give an agent access.</p>`
  }
  return html`<p class="small dim">Give an agent or a group access, or take a rule away:</p>${ownerCommands(view)}`
}

export function renderAccessPanel(view: FilesView): Html {
  return html`<section class="panel fl-panel" id="access" aria-label="Access">
    <div class="panel-hd"><h2>Access</h2></div>
    <div class="panel-bd">${accessTable(view.access)}${nextStep(view)}</div>
  </section>`
}
