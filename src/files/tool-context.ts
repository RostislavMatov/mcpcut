import { FILE_OPS, type FileOp } from './constants.js'
import type { IoResult } from './io-common.js'
import { resolveAgentPath, type ResolvedPath } from './paths.js'
import { opsAt, prepareRules, type FileRule, type PreparedRules } from './rights.js'
import type { SearchBackend } from './search/search-backend.js'

/** What one tools/call sees: roots and rules fetched fresh for this call only. */
export interface ToolContext {
  readonly roots: readonly string[]
  readonly rules: readonly FileRule[]
  readonly prepared: PreparedRules
  readonly actor: string
  readonly search?: SearchBackend
}

/** What one call needs from outside, fetched fresh each time (the server's and the gate's alike). */
export interface ContextSource {
  readonly roots: () => Promise<readonly string[]>
  readonly rules: () => Promise<readonly FileRule[]>
  readonly actor: string
  readonly search?: SearchBackend
}

export async function contextFor(source: ContextSource): Promise<ToolContext> {
  const [roots, rules] = await Promise.all([source.roots(), source.rules()])
  return {
    roots,
    rules,
    prepared: await prepareRules(rules),
    actor: source.actor,
    ...(source.search !== undefined ? { search: source.search } : {}),
  }
}

export interface ToolOutput {
  readonly text: string
  readonly isError: boolean
}

export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly output: ToolOutput }

export function textOutput(text: string): ToolOutput {
  return { text, isError: false }
}

export function errorOutput(text: string): ToolOutput {
  return { text, isError: true }
}

export function jsonOutput(value: unknown): ToolOutput {
  return textOutput(JSON.stringify(value))
}

/** Maps an I/O result to a tool output: failures carry the I/O layer's own one-line message. */
export function fromIo<T>(result: IoResult<T>, describe: (value: T) => ToolOutput): ToolOutput {
  return result.ok ? describe(result.value) : errorOutput(result.message)
}

/** The rules must be usable, then the path must lie within the roots. */
export async function resolveFor(ctx: ToolContext, raw: string): Promise<Outcome<ResolvedPath>> {
  if (!ctx.prepared.ok) return { ok: false, output: errorOutput(ctx.prepared.message) }
  const resolved = await resolveAgentPath(raw, ctx.roots)
  return resolved.ok ? { ok: true, value: resolved.path } : { ok: false, output: errorOutput(resolved.message) }
}

/** The rights held at the target when `op` is not among them; `null` when it is (or the rules are closed). */
export function rightsLacking(ctx: ToolContext, target: ResolvedPath, op: FileOp): readonly FileOp[] | null {
  if (!ctx.prepared.ok) return null
  const have = opsAt(target, ctx.prepared.rules)
  return have.includes(op) ? null : FILE_OPS.filter((item) => have.includes(item))
}

/** The first of `ops` the rules do not give at the target, with the rights that are held there; `null` when all are given. */
export function firstMissing(ctx: ToolContext, target: ResolvedPath, ops: readonly FileOp[]): Shortfall | null {
  for (const op of ops) {
    const held = rightsLacking(ctx, target, op)
    if (held !== null) return { op, held }
  }
  return null
}

export interface Shortfall {
  readonly op: FileOp
  readonly held: readonly FileOp[]
}

export function heldText(held: readonly FileOp[]): string {
  return held.length === 0 ? 'none' : held.join(', ')
}

/** The agent-facing refusal for a right it lacks — the server's answer and the gate's, word for word. */
export function noRightMessage(missing: Shortfall, raw: string): string {
  return `No right to ${missing.op} ${raw}: your rights there are ${heldText(missing.held)}. Call list_roots to see your folders.`
}

/** `null` when the rules give every one of `ops` at the resolved path, else the one-line refusal. */
export function requireOps(ctx: ToolContext, target: ResolvedPath, raw: string, ops: readonly FileOp[]): ToolOutput | null {
  if (!ctx.prepared.ok) return errorOutput(ctx.prepared.message)
  const missing = firstMissing(ctx, target, ops)
  return missing === null ? null : errorOutput(noRightMessage(missing, raw))
}

/** Resolve a path and require operations on it. */
export async function authorize(ctx: ToolContext, raw: string, ops: readonly FileOp[]): Promise<Outcome<ResolvedPath>> {
  const resolved = await resolveFor(ctx, raw)
  if (!resolved.ok) return resolved
  const refusal = requireOps(ctx, resolved.value, raw, ops)
  return refusal === null ? resolved : { ok: false, output: refusal }
}
