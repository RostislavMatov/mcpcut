import type { ArgsCheck, ArgsRefusal } from '../proxy/gate-args-check.js'
import { resolveWithinRoots, type ResolvedPath } from './paths.js'
import { carriedMessage, carriedShortfall, INNER_GRANT_RULE, innerGrantMessage, innerGrantOf } from './access-checks.js'
import { needsOf, opsOfNeed, type PathNeed } from './tool-access.js'
import { contextFor, firstMissing, heldText, type ContextSource, type ToolContext } from './tool-context.js'

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

/** Rights lacking on each path first, then what looks beyond one path: a moved or deleted folder's inner grants, a move's carried rights. */
async function refusalFor(ctx: ToolContext, needs: readonly PathNeed[]): Promise<ArgsRefusal | null> {
  if (!ctx.prepared.ok) return { rule: `files: ${ctx.prepared.problem}`, reason: ctx.prepared.message }
  const resolved: Resolved[] = []
  for (const need of needs) {
    const outcome = await resolveWithinRoots(need.raw, ctx.roots)
    if (!outcome.ok) return { rule: `files: ${outcome.refusal}`, reason: outcome.message }
    resolved.push({ need, target: outcome.path })
  }
  return lackingRight(ctx, resolved) ?? (await beyondOnePath(ctx, resolved))
}

function lackingRight(ctx: ToolContext, resolved: readonly Resolved[]): ArgsRefusal | null {
  for (const { need, target } of resolved) {
    const missing = firstMissing(ctx, target, opsOfNeed(need, target.exists))
    if (missing !== null) {
      return {
        rule: `files: no right ${missing.op} on ${shown(need.raw)}`,
        reason: `no right to ${missing.op} ${shown(need.raw)}: the agent's rights there are ${heldText(missing.held)}`,
      }
    }
  }
  return null
}

async function beyondOnePath(ctx: ToolContext, resolved: readonly Resolved[]): Promise<ArgsRefusal | null> {
  const [source, destination] = resolved
  if (source !== undefined && destination !== undefined) {
    const carried = carriedShortfall(ctx, source.target, destination.target)
    if (carried !== null) {
      return {
        rule: `files: no right ${carried.op} on ${shown(source.need.raw)}`,
        reason: shown(carriedMessage(carried, source.need.raw, destination.need.raw)),
      }
    }
  }
  for (const { need, target } of resolved) {
    if (!need.isRemoved) continue
    const inner = await innerGrantOf(ctx, target)
    if (inner !== null) return { rule: INNER_GRANT_RULE, reason: shown(innerGrantMessage(need.raw, inner)) }
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
