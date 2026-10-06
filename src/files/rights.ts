import path from 'node:path'
import { FILE_OPS, type FileOp } from './constants.js'
import { statIdentity, type FileIdentity } from './identity.js'
import { isWithinOn, lexicalKey, segmentCount } from './names.js'
import { realpathOf, type ResolvedPath } from './paths.js'

/**
 * An agent's file rights (ADR-0020 §2): rules `{ path, ops }` stored in
 * canonical form when granted. The deepest rule that contains the target
 * decides — a deeper rule narrows (empty `ops` cuts a subfolder out) or
 * widens; rules on the same folder add up, except that an empty one wins the
 * tie (a cut-out in one group is not undone by another group's grant).
 *
 * Rules are matched on file identities, like roots: an existing rule folder
 * by its dev/ino among the target's ancestors, so NFC/NFD, letter case or an
 * 8.3 name cannot slip past a cut-out. A rule folder that does not exist yet
 * is matched on its path, folded where volumes fold.
 *
 * Fail closed: a rule whose folder now resolves elsewhere (replaced by a
 * symlink — the grant would follow it) or cannot be resolved at all makes the
 * whole check deny, because silently dropping it could undo a cut-out.
 */

export interface FileRule {
  readonly path: string
  readonly ops: readonly FileOp[]
  /** On a cut-out granted on an existing folder: that folder's dev/ino, as decimal strings. */
  readonly identity?: { readonly dev: string; readonly ino: string } | undefined
}

export type PreparedRule =
  | ({ readonly kind: 'identity'; readonly ops: readonly FileOp[] } & FileIdentity)
  | { readonly kind: 'missing'; readonly path: string; readonly ops: readonly FileOp[] }

export type RulesProblem = 'rule-changed' | 'rule-unresolvable' | 'cut-out-moved'

export type PreparedRules =
  | { readonly ok: true; readonly rules: readonly PreparedRule[] }
  | { readonly ok: false; readonly problem: RulesProblem; readonly path: string; readonly message: string }

type RuleOutcome = PreparedRule | { readonly problem: RulesProblem }

/** A cut-out whose folder is gone from its path or is another folder now: its content may sit elsewhere, readable. */
function isCutOutMoved(rule: FileRule, found: FileIdentity | null): boolean {
  if (rule.identity === undefined) return false
  return found === null || String(found.dev) !== rule.identity.dev || String(found.ino) !== rule.identity.ino
}

async function prepareRule(rule: FileRule): Promise<RuleOutcome> {
  const outcome = await realpathOf(rule.path)
  if (outcome.kind === 'missing' && isCutOutMoved(rule, null)) return { problem: 'cut-out-moved' }
  if (outcome.kind !== 'found') {
    return outcome.kind === 'missing' ? { kind: 'missing', path: path.resolve(rule.path), ops: rule.ops } : { problem: 'rule-unresolvable' }
  }
  if (outcome.real !== path.resolve(rule.path)) return { problem: 'rule-changed' }
  const identity = await statIdentity(outcome.real)
  if (identity === null) return { problem: 'rule-unresolvable' }
  if (isCutOutMoved(rule, identity)) return { problem: 'cut-out-moved' }
  return { kind: 'identity', dev: identity.dev, ino: identity.ino, ops: rule.ops }
}

function problemMessage(problem: RulesProblem, rulePath: string): string {
  if (problem === 'cut-out-moved') {
    return `File access is closed: the cut-out folder ${rulePath} was moved, deleted or replaced. An administrator checks it and runs \`mcpcut files revoke\` or \`mcpcut files grant\` again.`
  }
  const what = problem === 'rule-changed' ? 'now resolves to a different place' : 'cannot be resolved'
  return `File access is closed: the granted folder ${rulePath} ${what}. An administrator re-grants it with \`mcpcut files grant\`.`
}

/** Identities of the rule folders, taken again on every call. */
export async function prepareRules(rules: readonly FileRule[]): Promise<PreparedRules> {
  const outcomes = await Promise.all(rules.map((rule) => prepareRule(rule)))
  const failed = outcomes.findIndex((outcome) => 'problem' in outcome)
  const failure = outcomes[failed]
  if (failure !== undefined && 'problem' in failure) {
    const rulePath = rules[failed]?.path ?? ''
    return { ok: false, problem: failure.problem, path: rulePath, message: problemMessage(failure.problem, rulePath) }
  }
  return { ok: true, rules: outcomes.filter((outcome): outcome is PreparedRule => !('problem' in outcome)) }
}

function depthOf(rule: PreparedRule, target: ResolvedPath): number | null {
  if (rule.kind === 'missing') {
    return isWithinOn(lexicalKey(rule.path), lexicalKey(target.absolute)) ? segmentCount(rule.path) : null
  }
  const entry = target.chain.find((ancestor) => ancestor.dev === rule.dev && ancestor.ino === rule.ino)
  return entry === undefined ? null : segmentCount(entry.path)
}

/** The operations the rules give on a resolved target. */
export function opsAt(target: ResolvedPath, rules: readonly PreparedRule[]): readonly FileOp[] {
  const matches = rules.flatMap((rule) => {
    const depth = depthOf(rule, target)
    return depth === null ? [] : [{ depth, ops: rule.ops }]
  })
  if (matches.length === 0) return []
  const deepest = Math.max(...matches.map((match) => match.depth))
  const tied = matches.filter((match) => match.depth === deepest)
  if (tied.some((match) => match.ops.length === 0)) return []
  const granted = new Set(tied.flatMap((match) => match.ops))
  return FILE_OPS.filter((op) => granted.has(op))
}

export function isAllowed(target: ResolvedPath, op: FileOp, rules: readonly PreparedRule[]): boolean {
  return opsAt(target, rules).includes(op)
}
