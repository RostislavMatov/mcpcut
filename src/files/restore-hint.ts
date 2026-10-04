import { replaceControlChars } from '../journal/format.js'

/** Characters a POSIX shell passes through unquoted and unexpanded. */
const SHELL_SAFE = /^[\w@%+=:,./-]+$/

function shellWord(value: string): string {
  const safe = replaceControlChars(value)
  return SHELL_SAFE.test(safe) ? safe : `'${safe.replaceAll("'", `'\\''`)}'`
}

/**
 * The exact command that puts a trashed item back, with the real root and id,
 * for the text an agent's `delete_file` returns (ADR-0020 §4). The tool layer
 * does not know how this process was started, so it names the bare binary.
 */
export function restoreCommandOf(root: string, id: string): string {
  return `mcpcut files trash restore ${shellWord(root)} ${shellWord(id)}`
}
