import { RESERVED_OBJECT_KEYS, TOOL_RULE_NAME_PATTERN } from './constants.js'

/** The wildcard suffix a tool-rule key may carry; a per-tool rule never does. */
export const TOOL_RULE_WILDCARD_SUFFIX = '*'

/**
 * True for a name a PER-TOOL rule may be written under: it fits the tool-rule
 * key shape, carries no wildcard (an exact key beats every `prefix*`, so the
 * per-tool buttons only ever write exact keys) and is not an object-prototype
 * key. Shared by both per-tool edits and their routes.
 */
export function isExactToolRuleName(name: string): boolean {
  return (
    TOOL_RULE_NAME_PATTERN.test(name) &&
    !name.endsWith(TOOL_RULE_WILDCARD_SUFFIX) &&
    !RESERVED_OBJECT_KEYS.includes(name)
  )
}
