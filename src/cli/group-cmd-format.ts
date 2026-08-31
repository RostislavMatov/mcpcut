import type { Role } from '../admin/authz.js'
import type { AgentGrant } from '../agents/schema.js'
import type { GroupRecord } from '../groups/schema.js'
import { formatReadableField } from '../journal/format.js'

/**
 * Rendering for `group list|show|grant` plus the stderr audit line, split out
 * of `group-cmd.ts` so the command module stays about control flow (token,
 * existence checks, store, journal) and this one about text.
 *
 * Every value that reaches a terminal here comes from an operator-typed name
 * or a hand-editable store document, so it goes through `formatReadableField`
 * first — the same rule the M2/M3 CLIs follow (a control character in a group
 * name must not be able to move the cursor).
 */

/** The admin a mutation was attributed to, as the audit line needs it. */
export interface GroupAuditActor {
  readonly adminName: string
  readonly role: Role
}

/** The mutating subcommands, as they appear in the audit line and the journal action. */
export type GroupOp = 'create' | 'remove' | 'grant' | 'ungrant' | 'join' | 'leave'

/** Column gap of the `group list` table (two spaces, like every other CLI table). */
const COLUMN_GAP = 2

const LIST_HEADERS = ['NAME', 'SERVERS', 'MEMBERS'] as const

/**
 * The audit line every successful mutation writes to stderr (ADR-0009 O5:
 * a store change made from a shell says who made it, right there in the
 * terminal, whether or not the journal record lands).
 */
export function auditLineOf(op: GroupOp, actor: GroupAuditActor, target: string): string {
  return `[audit] group ${op} by ${formatReadableField(actor.adminName)} (${actor.role}): ${target}\n`
}

/** `<group>/<server>` or `<group>/<agent>` — the two-part target, both halves sanitized. */
export function pairTarget(first: string, second: string): string {
  return `${formatReadableField(first)}/${formatReadableField(second)}`
}

/** `group list`: a padded NAME / SERVERS / MEMBERS table, or the empty marker. */
export function formatGroupTable(groups: readonly GroupRecord[]): string {
  if (groups.length === 0) return '(no groups)\n'

  const rows = groups.map((group) => [
    formatReadableField(group.name),
    String(Object.keys(group.grants).length),
    String(group.members.length),
  ])
  const widths = LIST_HEADERS.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  )
  const lines = [[...LIST_HEADERS], ...rows].map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join(' '.repeat(COLUMN_GAP))
      .trimEnd(),
  )
  return `${lines.join('\n')}\n`
}

/** `group show`: name, creation date, the grants block and the member list. */
export function formatGroupDetail(group: GroupRecord): string {
  const lines = [
    `name: ${formatReadableField(group.name)}`,
    `created: ${formatReadableField(group.createdAt)}`,
    'grants:',
    ...formatGrantLines(group.grants),
    `members: ${formatMembers(group.members)}`,
  ]
  return `${lines.join('\n')}\n`
}

/**
 * Indented lines per granted server: `<server>: tool, tool` (or `* (all
 * tools)`), plus one line each for the resources/prompts dimensions when
 * present. Deliberately the same layout `agent list` prints, so one grant
 * shape (G1) also reads the same in both commands.
 */
export function formatGrantLines(grants: GroupRecord['grants']): string[] {
  const entries = Object.entries(grants)
  if (entries.length === 0) return ['  (no grants)']
  return entries.flatMap(([server, grant]) => {
    const lines = [`  ${formatReadableField(server)}: ${formatPatterns(grant.tools, 'all tools')}`]
    if (grant.resources !== undefined) {
      lines.push(`    resources: ${formatPatterns(grant.resources, 'all resources')}`)
    }
    if (grant.prompts !== undefined) {
      lines.push(`    prompts: ${formatPatterns(grant.prompts, 'all prompts')}`)
    }
    return lines
  })
}

/** What `group grant` echoes back: the tools summary, then the opened method surfaces. */
export function formatGrantEcho(group: string, server: string, grant: AgentGrant): string {
  const lines = [
    `granted ${formatReadableField(server)} to group ${formatReadableField(group)}: ${formatPatterns(grant.tools, 'all tools')}`,
  ]
  if (grant.resources !== undefined) {
    lines.push(`  resources: ${formatPatterns(grant.resources, 'all resources')}`)
  }
  if (grant.prompts !== undefined) {
    lines.push(`  prompts: ${formatPatterns(grant.prompts, 'all prompts')}`)
  }
  return `${lines.join('\n')}\n`
}

/** The comma-joined member list of a refusal or of `group show`. */
export function formatMembers(members: readonly string[]): string {
  return members.length === 0 ? '(none)' : members.map(formatReadableField).join(', ')
}

/** `'*'` → `* (all …)`; array → sanitized, comma-joined patterns. */
function formatPatterns(patterns: '*' | readonly string[], everything: string): string {
  return patterns === '*' ? `* (${everything})` : patterns.map(formatReadableField).join(', ')
}
