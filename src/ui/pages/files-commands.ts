import { npxCommand, shellArg } from '../../cli/next-step.js'
import { html, type Html } from '../html.js'

/**
 * The `mcpcut files …` commands the Files page shows (ADR-0020). The page only
 * SHOWS them where the module's own CLI is the way to act: the npx form pinned
 * to this build is the CLI's `npxCommand`, and every value is one `shellArg`
 * word, so the page and the CLI print the same command. An absent value is
 * the placeholder an owner fills in.
 */

const FOLDER_PLACEHOLDER = '<folder>'
const AGENT_PLACEHOLDER = '<agent>'
const GROUP_PLACEHOLDER = '<group>'

function word(value: string | undefined, placeholder: string): string {
  return value === undefined ? placeholder : shellArg(value)
}

function filesCommand(args: string): string {
  return `${npxCommand()} files ${args}`
}

export function rootAddCommand(folder?: string): string {
  return filesCommand(`root add ${word(folder, FOLDER_PLACEHOLDER)}`)
}

export function grantCommand(agent?: string, folder?: string): string {
  return filesCommand(`grant ${word(agent, AGENT_PLACEHOLDER)} ${word(folder, FOLDER_PLACEHOLDER)} --ops read`)
}

export function groupGrantCommand(group?: string, folder?: string): string {
  return filesCommand(`grant --group ${word(group, GROUP_PLACEHOLDER)} ${word(folder, FOLDER_PLACEHOLDER)} --ops read`)
}

export function revokeCommand(agent: string, folder: string): string {
  return filesCommand(`revoke ${shellArg(agent)} ${shellArg(folder)}`)
}

export function rootListCommand(): string {
  return filesCommand('root list')
}

export function trashListCommand(root: string): string {
  return filesCommand(`trash list ${shellArg(root)}`)
}

export function trashPurgeCommand(root: string, days: number): string {
  return filesCommand(`trash purge ${shellArg(root)} --older-than-days ${String(days)}`)
}

/** The filters of a `files audit` call; an empty one is left out. */
export interface AuditCommandFilters {
  readonly path: string
  readonly agent: string
  readonly since: string
}

/** The full-list command for the filters on screen, at the CLI's largest page. */
export function auditCommand(filters: AuditCommandFilters, limit: number): string {
  const flags = [
    ...(filters.path === '' ? [] : [`--path ${shellArg(filters.path)}`]),
    ...(filters.agent === '' ? [] : [`--agent ${shellArg(filters.agent)}`]),
    ...(filters.since === '' ? [] : [`--since ${shellArg(filters.since)}`]),
    `--limit ${String(limit)}`,
  ]
  return filesCommand(`audit ${flags.join(' ')}`)
}

/** One command, ready to copy: the same block the Agents page uses for `adopt`. */
export function renderCommandBlock(command: string): Html {
  return html`<pre class="ag-config" data-files-command>${command}</pre>`
}
