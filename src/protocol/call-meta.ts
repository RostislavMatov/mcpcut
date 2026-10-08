/**
 * What a `tools/call`'s `params._meta` tells the gate. Split out of `mcp.ts`
 * for the <400-line file rule when decision M36's phase C gave `_meta` a
 * second job.
 *
 *  - `progressToken` (MCP): the token a held call's `notifications/progress`
 *    must name (phase A).
 *  - `claudecode/toolUseId`: Claude Code's id of the ONE tool use of the model
 *    a call carries out (`toolu_…`). A resend of the same tool use — Claude
 *    Code re-sends it after a 404, smoke 2026-10-09 — carries the same id; the
 *    model's own retry is a new tool use with a new id. It is what tells "a
 *    retry after a lost answer" from "a deliberate second call" (phase C).
 */

/** `_meta` key under which Claude Code names the tool use (smoke 2026-10-08, #1). */
export const CLAUDE_CODE_TOOL_USE_ID_META_KEY = 'claudecode/toolUseId'

/** Longest tool-use id accepted; Claude Code's are ~30 characters. */
export const MAX_TOOL_USE_ID_CHARS = 256

/** C0 controls and DEL: an id carrying one is not an id this gate keys anything by. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

export interface CallMeta {
  readonly progressToken?: string | number
  readonly toolUseId?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The `progressToken` of a request's `_meta`, if it is one a progress notification may name. */
function progressTokenOf(meta: Record<string, unknown>): string | number | undefined {
  const token = meta['progressToken']
  if (typeof token === 'string') return token
  return typeof token === 'number' && Number.isFinite(token) ? token : undefined
}

/** The tool-use id of a request's `_meta`, if it is one the gate may key a call by. */
function toolUseIdOf(meta: Record<string, unknown>): string | undefined {
  const id = meta[CLAUDE_CODE_TOOL_USE_ID_META_KEY]
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_TOOL_USE_ID_CHARS) return undefined
  return CONTROL_CHARACTER.test(id) ? undefined : id
}

/** Reads `params._meta`; every field is absent (not `undefined`) when the meta does not carry a usable one. */
export function callMetaOf(meta: unknown): CallMeta {
  if (!isPlainObject(meta)) return {}
  const progressToken = progressTokenOf(meta)
  const toolUseId = toolUseIdOf(meta)
  return {
    ...(progressToken !== undefined ? { progressToken } : {}),
    ...(toolUseId !== undefined ? { toolUseId } : {}),
  }
}
