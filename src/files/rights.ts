import path from 'node:path'
import { canonicalPath, isWithin } from './paths.js'

/**
 * An agent's file rights (ADR-0020 §2): rules `{ path, ops }` on canonical
 * folder or file paths. The deepest rule that contains the target decides —
 * a deeper rule narrows (empty `ops` cuts a subfolder out) or widens; rules
 * on the same path (the agent's own and its groups') add up. No containing
 * rule means no operations: fail closed.
 */

/** In the order they are shown and returned. */
export const FILE_OPS = ['read', 'write', 'edit', 'delete'] as const

export type FileOp = (typeof FILE_OPS)[number]

export interface FileRule {
  readonly path: string
  readonly ops: readonly FileOp[]
}

/** The operations the rules give on a canonical target. */
export function opsAt(target: string, rules: readonly FileRule[]): readonly FileOp[] {
  const containing = rules.filter((rule) => isWithin(rule.path, target))
  if (containing.length === 0) return []
  const depth = Math.max(...containing.map((rule) => rule.path.length))
  const granted = new Set(containing.filter((rule) => rule.path.length === depth).flatMap((rule) => rule.ops))
  return FILE_OPS.filter((op) => granted.has(op))
}

export function isAllowed(target: string, op: FileOp, rules: readonly FileRule[]): boolean {
  return opsAt(target, rules).includes(op)
}

/**
 * Rule paths are compared in canonical form, resolved again on every call
 * like the roots. A rule that cannot be resolved keeps its written (absolute,
 * normalized) path: dropping it would silently undo a cut-out.
 */
export async function canonicalRules(rules: readonly FileRule[]): Promise<readonly FileRule[]> {
  return Promise.all(
    rules.map(async (rule) => ({ path: (await canonicalPath(rule.path)) ?? path.resolve(rule.path), ops: rule.ops })),
  )
}
