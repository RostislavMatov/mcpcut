import { FILE_OPS, type FileOp } from './constants.js'
import type { IoResult } from './io-common.js'
import { resolveWithinRoots, type ResolvedPath } from './paths.js'
import { opsAt, type FileRule, type PreparedRules } from './rights.js'

/** What one tools/call sees: roots and rules fetched fresh for this call only. */
export interface ToolContext {
  readonly roots: readonly string[]
  readonly rules: readonly FileRule[]
  readonly prepared: PreparedRules
  readonly actor: string
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
  const resolved = await resolveWithinRoots(raw, ctx.roots)
  return resolved.ok ? { ok: true, value: resolved.path } : { ok: false, output: errorOutput(resolved.message) }
}

/** `null` when the rules give `op` at the resolved path, else the one-line refusal. */
export function requireOp(ctx: ToolContext, target: ResolvedPath, raw: string, op: FileOp): ToolOutput | null {
  if (!ctx.prepared.ok) return errorOutput(ctx.prepared.message)
  const have = opsAt(target, ctx.prepared.rules)
  if (have.includes(op)) return null
  const rights = have.length === 0 ? 'none' : FILE_OPS.filter((item) => have.includes(item)).join(', ')
  return errorOutput(`No right to ${op} ${raw}: your rights there are ${rights}. Call list_roots to see your folders.`)
}

/** Resolve a path and require one operation on it. */
export async function authorize(ctx: ToolContext, raw: string, op: FileOp): Promise<Outcome<ResolvedPath>> {
  const resolved = await resolveFor(ctx, raw)
  if (!resolved.ok) return resolved
  const refusal = requireOp(ctx, resolved.value, raw, op)
  return refusal === null ? resolved : { ok: false, output: refusal }
}
