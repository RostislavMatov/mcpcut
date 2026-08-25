import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { POLICY_FILE_NAME } from '../constants.js'
import { PROJECT_POLICY_SUBDIR } from '../load.js'

/**
 * Which file a policy edit (admin UI, `policy set`) is allowed to write.
 *
 * Exactly one: `<journalDir>/policy.json` — the source every entry point
 * falls back to and the one an agent-launched `connect` reads (ADR-0005,
 * ADR-0009). `connect` however resolves `<journalDir>/.mcp-journal/policy.json`
 * BEFORE the flat file (`source.ts`, `candidatesOf`): while that nested file
 * exists, an edit to the flat one would never reach an agent. Rather than
 * write into nowhere, the resolver reports the shadowing file so the caller
 * can refuse with an explanation. A probe that fails for any reason is
 * treated as shadowed — an edit must never proceed on a guess.
 */

export type PolicyWriteTarget =
  | { readonly status: 'ok'; readonly path: string }
  | { readonly status: 'shadowed'; readonly path: string; readonly shadowedBy: string }

export interface PolicyWriteTargetDeps {
  /** Whether a file exists at `path`. Defaults to `fs.access`. */
  readonly exists: (path: string) => Promise<boolean>
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export const defaultPolicyWriteTargetDeps: PolicyWriteTargetDeps = { exists: defaultExists }

export async function resolvePolicyWriteTarget(
  journalDir: string,
  deps: PolicyWriteTargetDeps = defaultPolicyWriteTargetDeps,
): Promise<PolicyWriteTarget> {
  const path = join(journalDir, POLICY_FILE_NAME)
  const shadowedBy = join(journalDir, PROJECT_POLICY_SUBDIR, POLICY_FILE_NAME)
  let shadowed: boolean
  try {
    shadowed = await deps.exists(shadowedBy)
  } catch {
    shadowed = true
  }
  return shadowed ? { status: 'shadowed', path, shadowedBy } : { status: 'ok', path }
}
