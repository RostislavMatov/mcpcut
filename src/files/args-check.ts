import type { ArgsCheck, ArgsRefusal } from '../proxy/gate-args-check.js'
import { resolveWithinRoots, type ResolvedPath } from './paths.js'
import { needsOf, WRITE_FILE_OPS, type PathNeed } from './tool-access.js'
import { contextFor, rightsLacking, type ContextSource, type ToolContext } from './tool-context.js'
import type { FileOp } from './constants.js'

/**
 * The gate's argument check for the built-in file server (ADR-0020 §2): the
 * SAME authorization the server runs before acting (prepared rules, then
 * `resolveWithinRoots`, then the rights at the resolved path), run one step
 * earlier so a refusal is a `deny` decision in the journal with a rule that
 * says why. It only ever refuses; whatever it cannot parse is left to the
 * server, which refuses it in its own words.
 */

const MAX_SHOWN_PATH_CHARS = 200
const CHECK_FAILED_RULE = 'files: check-failed'
const CHECK_FAILED_REASON = 'the file access check failed unexpectedly: try again, and if it keeps failing ask an administrator to check the mcpcut log'

/** A path as it appears in a rule string: one line, bounded. */
function shown(raw: string): string {
  const oneLine = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?')
  return oneLine.length > MAX_SHOWN_PATH_CHARS ? `${oneLine.slice(0, MAX_SHOWN_PATH_CHARS)}…` : oneLine
}

interface Resolved {
  readonly need: PathNeed
  readonly target: ResolvedPath
}

function opOf(need: PathNeed, target: ResolvedPath): FileOp {
  if (need.op !== 'create-or-replace') return need.op
  return target.exists ? WRITE_FILE_OPS.replace : WRITE_FILE_OPS.create
}

async function refusalFor(ctx: ToolContext, needs: readonly PathNeed[]): Promise<ArgsRefusal | null> {
  if (!ctx.prepared.ok) return { rule: `files: ${ctx.prepared.problem}`, reason: ctx.prepared.message }
  const resolved: Resolved[] = []
  for (const need of needs) {
    const outcome = await resolveWithinRoots(need.raw, ctx.roots)
    if (!outcome.ok) return { rule: `files: ${outcome.refusal}`, reason: outcome.message }
    resolved.push({ need, target: outcome.path })
  }
  for (const { need, target } of resolved) {
    const op = opOf(need, target)
    const rights = rightsLacking(ctx, target, op)
    if (rights !== null) {
      const held = rights.length === 0 ? 'none' : rights.join(', ')
      return { rule: `files: no right ${op} on ${shown(need.raw)}`, reason: `no right to ${op} ${shown(need.raw)}: the agent's rights there are ${held}` }
    }
  }
  return null
}

export function createFilesArgsCheck(source: ContextSource): ArgsCheck {
  return async (call) => {
    const needs = needsOf(call.toolName, call.args)
    if (needs === undefined || needs.length === 0) return null
    try {
      return await refusalFor(await contextFor(source), needs)
    } catch {
      // Tighten-only means fail closed: a check that could not run must not wave a call through.
      return { rule: CHECK_FAILED_RULE, reason: CHECK_FAILED_REASON }
    }
  }
}
