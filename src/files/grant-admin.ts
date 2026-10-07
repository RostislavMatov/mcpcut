import path from 'node:path'
import type { AgentGrant } from '../agents/schema.js'
import { FILE_OPS, FILES_SERVER_NAME, MAX_PATHS_PER_GRANT, type FileOp } from './constants.js'
import { statIdentity } from './identity.js'
import { canonicalPath, resolveWithinRoots, type PathRefusal } from './paths.js'
import type { FileRule } from './rights.js'

/**
 * What an admin does to an agent's folder rules (ADR-0020 §2): pure-ish
 * functions — the path is resolved against the disk, the grants are never
 * mutated; every result holds NEW objects.
 *
 * The rule path is stored as the resolver's canonical `absolute`: `rights.ts`
 * treats a rule whose realpath differs from its stored path as changed and
 * closes all file access, so a path typed through a symlink must not be kept
 * as typed.
 */

export type AgentGrants = Readonly<Record<string, AgentGrant>>

export type GrantRuleResult =
  | { readonly ok: true; readonly rule: FileRule }
  | { readonly ok: false; readonly message: string }

export type ApplyRuleResult =
  | { readonly ok: true; readonly grants: AgentGrants }
  | { readonly ok: false; readonly message: string }

export type GrantPathResult =
  | { readonly ok: true; readonly grants: AgentGrants; readonly rule: FileRule }
  | { readonly ok: false; readonly message: string }

export interface RevokeResult {
  readonly grants: AgentGrants
  /** Whether a rule was actually removed. */
  readonly removed: boolean
  /** Rules left in the files grant. */
  readonly remaining: number
}


/** Operations deduplicated and in the canonical `FILE_OPS` order. */
export function normalizeOps(ops: readonly FileOp[]): readonly FileOp[] {
  return FILE_OPS.filter((op) => ops.includes(op))
}

/** Why a resolver refusal reads differently to an admin than to an agent. */
export function adminMessage(refusal: PathRefusal, raw: string, roots: readonly string[], addRootCommand: string): string {
  const addRoot = `declare a root with \`${addRootCommand}\``
  switch (refusal) {
    case 'outside-roots':
      return roots.length === 0
        ? `no roots are declared yet: ${addRoot}, then grant it`
        : `${raw} is outside the declared roots (${roots.join(', ')}): ${addRoot} or pick a path inside one`
    case 'not-absolute':
      return `${raw} is not absolute: use a full path inside a declared root`
    case 'trash':
      return `${raw} is inside a trash folder: grant the folder that holds the files instead`
    case 'empty':
      return 'the path is empty: pass a full path inside a declared root'
    case 'nul-byte':
      return 'the path contains a NUL byte: retype it'
    case 'too-long':
      return 'the path is too long: use a shorter one'
    case 'dangling-symlink':
      return `${raw} is a symbolic link to nothing: fix or remove the link, or grant its folder`
    case 'reserved-name':
    case 'device-path':
      return `${raw} has a name Windows reserves: rename it or grant its folder`
    case 'unresolvable':
      return `${raw} cannot be resolved (link loop or unreadable folder): check the path`
    case 'mcpcut-settings':
      return `${raw} is inside mcpcut's own project settings: grant the folder that holds the files instead`
    case 'secret-like-name':
      return `${raw} has a name that looks like a secret: rename the folder`
    case 'non-canonical':
      return `${raw} is not how the disk names it: pass the path list_directory or \`ls\` shows`
    case 'dot-segment':
      return `${raw} has a "." or ".." segment: pass the full path without them`
  }
}

/**
 * The resolver's lexical gate refuses a path whose spelling is not under a
 * root as written — right for an agent, unfriendly for an admin who typed a
 * path through a symlinked ancestor of a root. Only on that refusal, and only
 * for an absolute path, the canonical form is tried.
 */
export async function resolveAsAdmin(raw: string, roots: readonly string[]): ReturnType<typeof resolveWithinRoots> {
  const first = await resolveWithinRoots(raw, roots)
  if (first.ok || first.refusal !== 'outside-roots' || !path.isAbsolute(raw)) return first
  const canonical = await canonicalPath(raw)
  return canonical === null || canonical === path.resolve(raw) ? first : resolveWithinRoots(canonical, roots)
}

/** Resolves `raw` inside the roots to its canonical rule path, or an admin-worded refusal. */
export async function resolveRulePath(
  roots: readonly string[],
  raw: string,
  addRootCommand: (folder: string) => string = (folder) => `mcpcut files root add ${folder}`,
): Promise<{ readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string }> {
  const resolved = await resolveAsAdmin(raw, roots)
  if (!resolved.ok) return { ok: false, message: adminMessage(resolved.refusal, raw, roots, addRootCommand(raw)) }
  return { ok: true, path: resolved.path.absolute }
}

function byPath(left: FileRule, right: FileRule): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}

/**
 * Replaces the rule on the same path or appends, keeps rules sorted by path,
 * enforces MAX_PATHS_PER_GRANT. Pure: runs inside the store's retried update.
 * A missing `files` grant becomes `{ tools: '*', paths: [rule] }`; the other
 * fields of an existing one are kept.
 */
export function applyRule(grants: AgentGrants, rule: FileRule): ApplyRuleResult {
  const current = grants[FILES_SERVER_NAME]
  const others = (current?.paths ?? []).filter((existing) => existing.path !== rule.path)
  if (others.length + 1 > MAX_PATHS_PER_GRANT) {
    return {
      ok: false,
      message: `at most ${MAX_PATHS_PER_GRANT} folder rules per agent: revoke one first with \`mcpcut files revoke <agent> <path>\``,
    }
  }
  const stored = { ...rule, ops: [...normalizeOps(rule.ops)] }
  const paths = [...others.map((other) => ({ ...other, ops: [...other.ops] })), stored].sort(byPath)
  const next: AgentGrant = { ...(current ?? { tools: '*' }), paths }
  return { ok: true, grants: { ...grants, [FILES_SERVER_NAME]: next } }
}

/** A cut-out on a canonical folder path, with the folder's identity when it exists (a later move or swap then closes access). */
export async function carveOutRule(folder: string): Promise<FileRule> {
  const identity = await statIdentity(folder)
  if (identity === null || !identity.isDirectory || identity.isSymbolicLink) return { path: folder, ops: [] }
  return { path: folder, ops: [], identity: { dev: String(identity.dev), ino: String(identity.ino) } }
}

/** The rule `files grant` stores: a cut-out remembers its folder, a grant is just the path and the operations. */
export async function ruleFor(folder: string, ops: readonly FileOp[]): Promise<FileRule> {
  const normalized = normalizeOps(ops)
  return normalized.length === 0 ? carveOutRule(folder) : { path: folder, ops: normalized }
}

/** Resolves `rawPath` against the roots and applies the rule — the whole of `files grant`. */
export async function grantPath(
  agentGrants: AgentGrants,
  roots: readonly string[],
  rawPath: string,
  ops: readonly FileOp[],
): Promise<GrantPathResult> {
  const resolved = await resolveRulePath(roots, rawPath)
  if (!resolved.ok) return resolved
  const rule = await ruleFor(resolved.path, ops)
  const applied = applyRule(agentGrants, rule)
  return applied.ok ? { ok: true, grants: applied.grants, rule } : applied
}

/** The stored spellings a typed path can match: canonical form, and the plain resolution as a fallback. */
export async function ruleKeysOf(rawPath: string): Promise<readonly string[]> {
  const plain = path.resolve(rawPath)
  const canonical = await canonicalPath(plain)
  return canonical === null || canonical === plain ? [plain] : [canonical, plain]
}

/**
 * Removes the rule whose path is one of `keys` (pure — runs inside the
 * store's retried update). When the last rule goes the `paths` field is
 * dropped entirely (`{ tools }` stays): no field means no file rights, which
 * the caller reports as "no file access". The grant is kept, not removed, so
 * a tools restriction the admin set survives. No match returns the very same
 * `grants` object.
 */
export function dropRule(grants: AgentGrants, keys: readonly string[]): RevokeResult {
  const current = grants[FILES_SERVER_NAME]
  const rules = current?.paths ?? []
  const kept = rules.filter((rule) => !keys.includes(rule.path))
  if (current === undefined || kept.length === rules.length) return { grants, removed: false, remaining: rules.length }
  const { paths: _dropped, ...rest } = current
  const next: AgentGrant = kept.length === 0 ? rest : { ...rest, paths: kept.map((rule) => ({ ...rule, ops: [...rule.ops] })) }
  return { grants: { ...grants, [FILES_SERVER_NAME]: next }, removed: true, remaining: kept.length }
}

/** `files revoke`: the rule for the canonical form of `rawPath` (or its plain resolution). */
export async function revokePath(agentGrants: AgentGrants, rawPath: string): Promise<RevokeResult> {
  return dropRule(agentGrants, await ruleKeysOf(rawPath))
}

/** Raised inside the store's update when a rule cannot be applied; the CLI prints its message as is. */
export class RuleRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuleRefusedError'
  }
}

/** The `files` grant of one agent as the single-entry grants record the pure functions take. */
export function filesGrantsOf(current: AgentGrant | undefined): AgentGrants {
  return current === undefined ? {} : { [FILES_SERVER_NAME]: current }
}
