import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Policy } from '../schema.js'
import { resolvePolicySource } from '../source.js'
import { defaultPolicyFileDeps, readPolicyFileForEdit, type PolicyFileReadResult } from './policy-file.js'
import { resolvePolicyWriteTarget, type PolicyWriteTarget } from './write-target.js'

/**
 * The policy as the admin UI shows it (plan policy-tool-rules-ui §6, the
 * ADR-0005 "effective policy and its source" panel): the flat
 * `<journalDir>/policy.json` read for edit, whether `connect` would load a
 * nested file before it (finding 5a — edits must then be refused), and,
 * when it differs, the file an operator-launched `serve`/`wrap` started from
 * the UI process's own env/cwd would load first. Read-only: nothing here
 * writes, and every failure shape is a value the page can render.
 */

export interface PolicyViewSources {
  /** The one file an edit writes: `<journalDir>/policy.json`. */
  readonly sourcePath: string
  /** Set when `<journalDir>/.mcp-journal/policy.json` exists — `connect` loads THAT first. */
  readonly shadowedBy?: string
  /**
   * What `serve`/`wrap` would load first for this process's env/cwd, when it
   * is a different file from `sourcePath`; absent when they agree.
   */
  readonly operatorSourcePath?: string
}

export type PolicyView = PolicyViewSources &
  (
    | { readonly status: 'loaded'; readonly policy: Policy; readonly hash: string }
    | { readonly status: 'absent' }
    | { readonly status: 'error'; readonly errors: readonly string[] }
  )

export interface ReadPolicyViewArgs {
  readonly journalDir: string
  /** Environment of the UI process (what an operator-launched entry would see). Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Working directory of the UI process. Defaults to `process.cwd()`. */
  readonly cwd?: string
}

export interface ReadPolicyViewDeps {
  readonly resolveWriteTarget: (journalDir: string) => Promise<PolicyWriteTarget>
  readonly readPolicyFile: (path: string) => Promise<PolicyFileReadResult>
  readonly exists: (path: string) => Promise<boolean>
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export const defaultReadPolicyViewDeps: ReadPolicyViewDeps = {
  resolveWriteTarget: (journalDir) => resolvePolicyWriteTarget(journalDir),
  readPolicyFile: (path) => readPolicyFileForEdit(path, defaultPolicyFileDeps),
  exists: defaultExists,
}

export async function readPolicyView(
  args: ReadPolicyViewArgs,
  deps: ReadPolicyViewDeps = defaultReadPolicyViewDeps,
): Promise<PolicyView> {
  const target = await deps.resolveWriteTarget(args.journalDir)
  const [read, operatorSourcePath] = await Promise.all([
    deps.readPolicyFile(target.path),
    operatorSourceOf(args, target.path, deps.exists),
  ])
  const sources: PolicyViewSources = {
    sourcePath: target.path,
    ...(target.status === 'shadowed' ? { shadowedBy: target.shadowedBy } : {}),
    ...(operatorSourcePath !== undefined ? { operatorSourcePath } : {}),
  }
  if (read.status === 'loaded') return { ...sources, status: 'loaded', policy: read.policy, hash: read.hash }
  if (read.status === 'error') return { ...sources, status: 'error', errors: read.errors }
  return { ...sources, status: 'absent' }
}

/**
 * The first candidate an operator-launched entry would actually load: a
 * required one (`--policy`, `$MCP_JOURNAL_POLICY`) unconditionally, an
 * optional one only if it exists. A probe that fails counts as "not there"
 * — this is display, and the write target is decided elsewhere.
 */
async function operatorSourceOf(
  args: ReadPolicyViewArgs,
  writePath: string,
  exists: ReadPolicyViewDeps['exists'],
): Promise<string | undefined> {
  const resolved = await resolvePolicySource({
    entryPoint: 'serve',
    journalDir: args.journalDir,
    env: args.env ?? process.env,
    cwd: args.cwd ?? process.cwd(),
  })
  if (resolved.status !== 'resolved') return undefined
  for (const candidate of resolved.candidates) {
    const isLoaded = candidate.required || (await exists(candidate.path).catch(() => false))
    if (!isLoaded) continue
    return resolve(candidate.path) === resolve(writePath) ? undefined : candidate.path
  }
  return undefined
}
