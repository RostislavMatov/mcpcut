import type { AgentRecord } from '../agents/schema.js'
import { effectiveGrantsOf, type GrantSource } from '../agents/effective.js'
import type { GroupRecord } from '../groups/schema.js'
import { formatReadableField } from '../journal/format.js'

/**
 * Rendering for `agent list|grant`, split out of `agent-cmd.ts` so the command
 * module stays about control flow (arguments, owner gate, store, journal) and
 * this one about text — the same split `group-cmd-format.ts` follows.
 *
 * Every value that reaches a terminal here comes from an operator-typed name
 * or a hand-editable store document, so it goes through `formatReadableField`
 * first, and no hash ever appears.
 */

/** Header line: name, creation date, revocation marker. Never the token hash. */
export function formatAgentLine(agent: AgentRecord): string {
  const name = formatReadableField(agent.name)
  const created = `created ${formatReadableField(agent.createdAt)}`
  const revoked =
    agent.revokedAt === undefined ? '' : `  REVOKED ${formatReadableField(agent.revokedAt)}`
  return `${name}  ${created}${revoked}`
}

/**
 * Indented lines per EFFECTIVE granted server: `<server>: tool, tool` (or
 * `* (all tools)`), plus one extra line each for the resources/prompts
 * dimensions when present (M4 Task 6) — absent fields print nothing, so
 * pre-M4 grants render exactly as before.
 *
 * Rows carry their provenance when a group is involved: ` (via group:…)` for
 * a server the agent only reaches through its groups, ` (overrides group:…)`
 * for a personal grant that takes a server the groups also grant (G2 — the
 * personal grant wins WHOLESALE, so the tools shown are the personal ones).
 * An agent in no group has neither suffix and renders byte-identically to
 * before groups existed.
 */
export function formatGrantLines(agent: AgentRecord, groups: readonly GroupRecord[]): string[] {
  const effective = effectiveGrantsOf(agent, groups)
  const entries = Object.entries(effective.grants)
  if (entries.length === 0) {
    return ['  (no grants)']
  }
  return entries.flatMap(([server, grant]) => {
    const origin = formatOrigin(effective.sources, server)
    const lines = [
      `  ${formatReadableField(server)}: ${formatPatterns(grant.tools, 'all tools')}${origin}`,
    ]
    if (grant.resources !== undefined) {
      lines.push(`    resources: ${formatPatterns(grant.resources, 'all resources')}`)
    }
    if (grant.prompts !== undefined) {
      lines.push(`    prompts: ${formatPatterns(grant.prompts, 'all prompts')}`)
    }
    return lines
  })
}

/**
 * The provenance suffix of one row, or `''` when no group is involved.
 * `Object.hasOwn` because the key is a server name read off a document.
 */
function formatOrigin(sources: Readonly<Record<string, GrantSource>>, server: string): string {
  const source = Object.hasOwn(sources, server) ? sources[server] : undefined
  if (source === undefined) return ''
  const names = source.kind === 'group' ? source.groups : source.shadowedGroups
  if (names.length === 0) return ''
  const label = source.kind === 'group' ? 'via' : 'overrides'
  const list = names.map((name) => `group:${formatReadableField(name)}`).join(', ')
  return ` (${label} ${list})`
}

/** `'*'` → `* (all …)`; array → sanitized, comma-joined patterns. */
function formatPatterns(patterns: '*' | readonly string[], everything: string): string {
  return patterns === '*' ? `* (${everything})` : patterns.map(formatReadableField).join(', ')
}

/** `'*'` → `* (all …)`; array → raw comma-joined patterns (sanitized by the caller). */
export function summaryOf(patterns: '*' | readonly string[], everything: string): string {
  return patterns === '*' ? `* (${everything})` : patterns.join(', ')
}
