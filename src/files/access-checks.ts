import { MOVE_CARRIED_OPS } from './tool-access.js'
import { statIdentity } from './identity.js'
import { isWithinOn, lexicalKey } from './names.js'
import { realpathOf, type ResolvedPath } from './paths.js'
import { rightsLacking, type Shortfall, type ToolContext } from './tool-context.js'

/**
 * Checks that look beyond one path's own rights (security review H1, M2),
 * shared by the server's handlers and the gate's argument check so both give
 * the same answer from the same context.
 */

/** Rule that names the H1 refusal in the gate's journal entry. */
export const INNER_GRANT_RULE = 'files: separately granted folder inside'

/**
 * A right the destination gives that the source does not: `read` or `edit`
 * there must also hold at the source, otherwise moving would hand the agent
 * a right over the entry that it never had where the entry was.
 */
export function carriedShortfall(ctx: ToolContext, source: ResolvedPath, destination: ResolvedPath): Shortfall | null {
  for (const op of MOVE_CARRIED_OPS) {
    if (rightsLacking(ctx, destination, op) !== null) continue
    const held = rightsLacking(ctx, source, op)
    if (held !== null) return { op, held }
  }
  return null
}

async function grantSpellings(ctx: ToolContext): Promise<readonly string[]> {
  const declared = [...ctx.rules.map((rule) => rule.path), ...ctx.roots]
  const canonical = await Promise.all(
    ctx.roots.map(async (root) => {
      const outcome = await realpathOf(root)
      return outcome.kind === 'found' ? [outcome.real] : []
    }),
  )
  return [...declared, ...canonical.flat()]
}

/**
 * When `target` is an existing folder, the first rule path or declared root
 * that lies strictly inside it (folded the way the volume folds); `null`
 * for a file, a missing path or a folder with nothing separately granted
 * inside. Moving or deleting such a folder would take that grant with it.
 */
export async function innerGrantOf(ctx: ToolContext, target: ResolvedPath): Promise<string | null> {
  if (!target.exists) return null
  const stat = await statIdentity(target.absolute)
  if (stat === null || !stat.isDirectory) return null
  const outer = lexicalKey(target.absolute)
  const inside = (await grantSpellings(ctx)).find((candidate) => {
    const key = lexicalKey(candidate)
    return key !== outer && isWithinOn(outer, key)
  })
  return inside ?? null
}

export function innerGrantMessage(raw: string, inner: string): string {
  return `${raw} contains a separately granted folder ${inner}; move or delete what is inside instead, or ask an administrator`
}

/** The one-line refusal when a move would carry `shortfall.op` to where the source does not have it. */
export function carriedMessage(shortfall: Shortfall, rawSource: string, rawDestination: string): string {
  return `No right to ${shortfall.op} ${rawSource}: moving it to ${rawDestination} would give you ${shortfall.op} there, which you lack at the source (${shortfall.held.length === 0 ? 'none' : shortfall.held.join(', ')}).`
}
