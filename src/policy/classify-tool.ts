import { CONFUSABLE_FOLD, DESTRUCTIVE_NAME_HEURISTICS } from './constants.js'
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
 * NFKC-normalizes `name` (folding fullwidth/compatibility forms) so a server
 * cannot dodge the heuristics with compatibility code points. Inputs that
 * fail to normalize (never expected) fall back to the raw name.
 */
function normalizeName(name: string): string {
  try {
    return name.normalize('NFKC')
  } catch {
    return name
  }
}

/**
 * Escalation-only homoglyph fold: replaces confusable Cyrillic/Greek code
 * points with their ASCII look-alike so `dеlete_all` (Cyrillic `е`) still
 * trips the `delete` heuristic. Only ever used to RAISE a classification.
 */
function foldConfusables(name: string): string {
  let out = ''
  for (const ch of name) {
    out += CONFUSABLE_FOLD[ch] ?? ch
  }
  return out
}

/** True if `name` still contains a non-ASCII code point after NFKC normalization. */
function hasNonAsciiLetter(name: string): boolean {
  for (const ch of name) {
    if ((ch.codePointAt(0) ?? 0) > 0x7f) return true
  }
  return false
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

function tokensMatchHeuristic(tokens: readonly string[]): boolean {
  return DESTRUCTIVE_NAME_HEURISTICS.some((heuristic) => tokens.includes(normalizeHeuristic(heuristic)))
}

/**
 * True if any `DESTRUCTIVE_NAME_HEURISTICS` word appears as a whole token in
 * the tool name. Checks both the NFKC-normalized name and a homoglyph-folded
 * copy, so a Cyrillic/Greek look-alike (`dеlete_all`) cannot slip past.
 * Escalation-only by design (see `classifyTool`): a server cannot avoid this
 * by naming a tool `dropdown_menu` (no `drop` token) nor evade it by naming
 * one `undelete_item` (no `delete` token).
 */
function nameMatchesDestructiveHeuristic(normalized: string): boolean {
  if (tokensMatchHeuristic(tokenizeToolName(normalized))) return true
  return tokensMatchHeuristic(tokenizeToolName(foldConfusables(normalized)))
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
 *  2. `annotations.destructiveHint === true`, or the NFKC-normalized (and
 *     homoglyph-folded) tool name matches a `DESTRUCTIVE_NAME_HEURISTICS`
 *     word as a whole token -> `destructive`.
 *  3. `annotations.readOnlyHint === true`, the tool is not destructive, AND
 *     the name is pure ASCII after normalization -> `read`.
 *  4. Otherwise -> `write` (safe default). A name that still contains a
 *     non-ASCII code point after normalization can never be downgraded to
 *     `read` by `readOnlyHint`: an unmappable confusable is a red flag, so it
 *     floors at `write`.
 *
 * Server-supplied annotations are untrusted hints: `readOnlyHint` can never
 * downgrade a tool whose name matches a destructive heuristic, nor one whose
 * name smuggles non-ASCII confusables. Pure function, no I/O.
 */
export function classifyTool(
  tool: ClassifiableTool,
  overrides?: Record<string, ToolClass>,
): ToolClass {
  const override = matchOverride(overrides, tool.name)
  if (override !== undefined) return override

  const normalized = normalizeName(tool.name)

  const isDestructive =
    tool.annotations?.destructiveHint === true || nameMatchesDestructiveHeuristic(normalized)
  if (isDestructive) return 'destructive'

  // A non-ASCII name (after normalization) is suspicious: never let an
  // untrusted `readOnlyHint` downgrade it below `write`.
  if (tool.annotations?.readOnlyHint === true && !hasNonAsciiLetter(normalized)) return 'read'

  return 'write'
}
