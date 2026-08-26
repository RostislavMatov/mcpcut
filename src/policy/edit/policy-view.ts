import type { Policy } from '../schema.js'
import { defaultPolicyFileDeps, readPolicyFileForEdit, type PolicyFileReadResult } from './policy-file.js'
import {
  resolvePolicyEditTarget,
  type PolicyEditTarget,
  type PolicyEditTargetArgs,
  type PolicyTargetReaders,
} from './write-target.js'

/**
 * The policy as the admin UI shows it (plan policy-tool-rules-ui §6, the
 * ADR-0005 "effective policy and its source" panel, corrected 2026-08-26):
 * the file THIS process resolved through the operator-launched source order,
 * read for edit, plus the computed statement of which entry points read it.
 *
 * One file, one story: what the card displays is what an edit writes and what
 * this process's own entry point loaded. Read-only — nothing here writes, and
 * every failure shape is a value the page can render.
 */

export interface PolicyViewSources {
  /** The file shown and edited: the first source of the operator-launched order that resolves here. */
  readonly sourcePath: string
  /** Which entry points load `sourcePath` — displayed, never a reason to refuse an edit. */
  readonly readers: PolicyTargetReaders
}

export type PolicyView = PolicyViewSources &
  (
    | { readonly status: 'loaded'; readonly policy: Policy; readonly hash: string }
    | { readonly status: 'absent' }
    | { readonly status: 'error'; readonly errors: readonly string[] }
  )

export type ReadPolicyViewArgs = PolicyEditTargetArgs

export interface ReadPolicyViewDeps {
  readonly resolveTarget: (args: PolicyEditTargetArgs) => Promise<PolicyEditTarget>
  readonly readPolicyFile: (path: string) => Promise<PolicyFileReadResult>
}

export const defaultReadPolicyViewDeps: ReadPolicyViewDeps = {
  resolveTarget: (args) => resolvePolicyEditTarget(args),
  readPolicyFile: (path) => readPolicyFileForEdit(path, defaultPolicyFileDeps),
}

export async function readPolicyView(
  args: ReadPolicyViewArgs,
  deps: ReadPolicyViewDeps = defaultReadPolicyViewDeps,
): Promise<PolicyView> {
  const target = await deps.resolveTarget(args)
  const read = await deps.readPolicyFile(target.path)
  const sources: PolicyViewSources = { sourcePath: target.path, readers: target.readers }
  if (read.status === 'loaded') return { ...sources, status: 'loaded', policy: read.policy, hash: read.hash }
  if (read.status === 'error') return { ...sources, status: 'error', errors: read.errors }
  return { ...sources, status: 'absent' }
}
