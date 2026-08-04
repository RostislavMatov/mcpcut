import { DESTRUCTIVE_NAME_HEURISTICS } from './constants.js'
import type { ToolClass } from './schema.js'

/**
 * Minimal structural shape this module needs from a tool descriptor. Defined
 * locally (rather than imported from `protocol/mcp.ts`) because that module
 * is owned by a parallel task in this wave; any object with a compatible
 * shape -- including the real `ToolDescriptor` -- satisfies this type.
 */
export interface ClassifiableToolAnnotations {
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
}

export interface ClassifiableTool {
  readonly name: string
  readonly annotations?: ClassifiableToolAnnotations
}

/**
 * Splits a tool name into lowercase word tokens on `_`, `-`, `.`, `:`,
 * whitespace, and camelCase boundaries. Used so the destructive-name
 * heuristic matches whole words (`delete_user`, `deleteUser` -> `delete`)
 * and never a mere substring (`undelete_item`, `dropdown_menu` must not
 * match `delete` / `drop`).
 */
function tokenizeToolName(name: string): string[] {
  const withCamelBoundaries = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  return withCamelBoundaries
    .split(/[_\-.:\s]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0)
}

/**
 * `DESTRUCTIVE_NAME_HEURISTICS` stores `force_` with a trailing underscore
 * (a prefix in the constant's own substring-oriented doc comment); this
 * module instead matches whole tokens, so the trailing underscore is
 * stripped once here to get the bare word (`force`) to compare against.
 */
function normalizeHeuristic(heuristic: string): string {
  return heuristic.endsWith('_') ? heuristic.slice(0, -1).toLowerCase() : heuristic.toLowerCase()
}

/**
 * True if any `DESTRUCTIVE_NAME_HEURISTICS` word appears as a whole token in
 * the tool name. Escalation-only by design (see `classifyTool`): a server
 * cannot avoid this by naming a tool `dropdown_menu` (no `drop` token) nor
 * evade it by naming one `undelete_item` (no `delete` token).
 */
function nameMatchesDestructiveHeuristic(name: string): boolean {
  const tokens = tokenizeToolName(name)
  return DESTRUCTIVE_NAME_HEURISTICS.some((heuristic) => tokens.includes(normalizeHeuristic(heuristic)))
}

/**
 * Resolves a config override for `toolName`, if any. Exact name wins over a
 * trailing-glob prefix match; among glob matches, the longest prefix wins.
 * Mirrors the matching semantics `policy/match.ts` uses for tool rules, kept
 * local here (and intentionally tiny) to avoid a cross-task dependency on a
 * file another parallel task owns.
 */
function matchOverride(
  overrides: Record<string, ToolClass> | undefined,
  toolName: string,
): ToolClass | undefined {
  if (!overrides) return undefined
  if (Object.hasOwn(overrides, toolName)) return overrides[toolName]

  let bestPrefixLength = -1
  let bestClass: ToolClass | undefined
  for (const [key, value] of Object.entries(overrides)) {
    if (!key.endsWith('*')) continue
    const prefix = key.slice(0, -1)
    if (toolName.startsWith(prefix) && prefix.length > bestPrefixLength) {
      bestPrefixLength = prefix.length
      bestClass = value
    }
  }
  return bestClass
}

/**
 * Classifies a tool as `read`, `write`, or `destructive`.
 *
 * Precedence (strict, first match wins):
 *  1. A config override matching `tool.name` (exact beats longest trailing
 *     glob) -- the operator always wins over any heuristic or annotation.
 *  2. `annotations.destructiveHint === true`, or the tool name matches a
 *     `DESTRUCTIVE_NAME_HEURISTICS` word as a whole token -> `destructive`.
 *  3. `annotations.readOnlyHint === true` (and nothing escalated in step 2)
 *     -> `read`.
 *  4. Otherwise -> `write` (safe default; unannotated tools are `write`).
 *
 * Server-supplied annotations are untrusted hints: `readOnlyHint` can never
 * downgrade a tool whose name matches a destructive heuristic, so a server
 * cannot self-declare `delete_everything` safe by omitting or lying about
 * `destructiveHint`. Pure function, no I/O.
 */
export function classifyTool(
  tool: ClassifiableTool,
  overrides?: Record<string, ToolClass>,
): ToolClass {
  const override = matchOverride(overrides, tool.name)
  if (override !== undefined) return override

  const isDestructive =
    tool.annotations?.destructiveHint === true || nameMatchesDestructiveHeuristic(tool.name)
  if (isDestructive) return 'destructive'

  if (tool.annotations?.readOnlyHint === true) return 'read'

  return 'write'
}
