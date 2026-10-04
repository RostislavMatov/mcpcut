import type { AgentRecord } from '../agents/schema.js'
import type { GrantSource } from '../agents/effective.js'
import type { FileRule } from '../files/rights.js'
import { formatReadableField } from '../journal/format.js'
import { cliCommand, shellArg } from './next-step.js'

/** Rendering for `mcpcut files …`: every printed value is terminal-sanitized, every output ends in a next step. */

/** `  <path>: read, write` — an empty list is a cut-out and says so. */
export function formatRuleLine(rule: FileRule): string {
  const ops = rule.ops.length === 0 ? '(no access - cut out)' : rule.ops.join(', ')
  return `  ${formatReadableField(rule.path)}: ${ops}`
}

export function formatRuleLines(rules: readonly FileRule[]): string[] {
  return rules.map(formatRuleLine)
}

/** `(via group:a, group:b)` / `(overrides group:a)` / `''` — where the rules come from. */
export function formatRulesOrigin(source: GrantSource | undefined): string {
  if (source === undefined) return ''
  const names = source.kind === 'group' ? source.groups : source.shadowedGroups
  if (names.length === 0) return ''
  const list = names.map((name) => `group:${formatReadableField(name)}`).join(', ')
  return source.kind === 'group' ? ` (inherited via ${list})` : ` (overrides ${list})`
}

/**
 * The next step after a root exists: grant it to an agent — with the real
 * agent name when there is exactly one, the way to create one when there is
 * none, a placeholder plus the names when there are several.
 */
export function grantNextStep(env: NodeJS.ProcessEnv, agents: readonly AgentRecord[], folder: string): string {
  const cli = cliCommand(env)
  const live = agents.filter((agent) => agent.revokedAt === undefined).map((agent) => agent.name)
  const target = shellArg(folder)
  const [only] = live
  if (live.length === 0) {
    return `No agent yet. Create one: ${cli} agent create <name>, then: ${cli} files grant <name> ${target} --ops read\n`
  }
  if (live.length === 1 && only !== undefined) {
    return `Give an agent access: ${cli} files grant ${shellArg(only)} ${target} --ops read\n`
  }
  const names = live.map(formatReadableField).join(', ')
  return `Give an agent access: ${cli} files grant <agent> ${target} --ops read   (agents: ${names})\n`
}

export const FILES_USAGE = `Usage:
  mcpcut files root add <folder> | list | remove <folder>
                                         Declare, list or drop the folders the file module works in
  mcpcut files grant <agent> <folder> --ops read,write,edit,delete|none
                                         Give an agent operations on a folder (none cuts a subfolder out)
  mcpcut files revoke <agent> <folder>   Remove the agent's rule for a folder
  mcpcut files show <agent>              Print the agent's folder rules
  mcpcut files grant --group <group> <folder> --ops read,write,edit,delete|none
  mcpcut files revoke --group <group> <folder>
  mcpcut files show --group <group>      The same three for a group: its members inherit the rules
  mcpcut files audit [--path <path>] [--agent <name>] [--since <YYYY-MM-DD|Nd>] [--limit <n>] [--json]
                                         Who touched what: file operations and admin edits, newest first
  mcpcut files trash list [<root>] | restore <root> <id> | purge <root> [--older-than-days N]
                                         List what agents deleted, put an item back, or delete
                                         old ones for good (default 30 days; serve does it daily)
Changes need an owner token in MCP_ADMIN_TOKEN; list and show do not.
`

export const FILES_TRASH_USAGE = `Usage:
  mcpcut files trash list [<root>]
  mcpcut files trash restore <root> <id>
  mcpcut files trash purge <root> [--older-than-days N]   (N: 1 to 3650, default 30)
Restore and purge need an owner token in MCP_ADMIN_TOKEN; list does not.
`
