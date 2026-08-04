/**
 * Generic tool-rule matcher shared by every policy map keyed on tool name
 * (`servers.<name>.tools`, and mirrored locally by `classify-tool.ts` for
 * `classOverrides` to avoid a cross-task dependency during the M2 parallel
 * wave -- see that file's `matchOverride` for the sibling implementation).
 */

/** A resolved rule match: the rule's value, plus the pattern that matched it. */
export interface ToolRuleMatch<T> {
  readonly value: T
  readonly pattern: string
}

/**
 * Resolves the rule that applies to `toolName` from a map of tool-name
 * patterns to values.
 *
 * Precedence (strict, first match wins):
 *  1. An exact key equal to `toolName` -- always wins, regardless of any
 *     glob entry also present or the map's key order.
 *  2. Among keys ending in a single trailing `*`, the one whose prefix is a
 *     prefix of `toolName` and is *longest* wins (`github_*` beats `git*`
 *     for `github_create_issue`).
 *  3. No match -> `null`.
 *
 * Patterns are schema-validated upstream (`TOOL_RULE_NAME_PATTERN`: exact
 * name, or a single trailing `*`, no mid-name wildcards) but this function
 * still behaves sanely on a map that was built by hand or in a test: a key
 * without a trailing `*` is only ever compared as a literal, never treated
 * as a glob.
 */
export function matchToolRule<T>(
  rules: Record<string, T> | undefined,
  toolName: string,
): ToolRuleMatch<T> | null {
  if (!rules) return null

  if (Object.hasOwn(rules, toolName)) {
    return { value: rules[toolName] as T, pattern: toolName }
  }

  let best: ToolRuleMatch<T> | null = null
  let bestPrefixLength = -1

  for (const [pattern, value] of Object.entries(rules)) {
    if (!pattern.endsWith('*')) continue
    const prefix = pattern.slice(0, -1)
    if (!toolName.startsWith(prefix)) continue
    if (prefix.length <= bestPrefixLength) continue
    bestPrefixLength = prefix.length
    best = { value, pattern }
  }

  return best
}
