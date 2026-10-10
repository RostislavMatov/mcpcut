import { existsSync } from 'node:fs'
import { JOURNAL_DIR } from '../config.js'
import { dataDirPolicyPath, defaultPolicyCandidates } from '../policy/source.js'

export interface PolicyLookupOptions {
  readonly cwd?: string
  readonly journalDir?: string
}

/**
 * The policy file `wrap` would pick up on its own (no `--policy`, no
 * `MCPCUT_POLICY`): `defaultPolicyCandidates`, the list the loader's own
 * resolution is pinned to. `undefined`
 * when neither exists, which is what an empty `approvals list` turns into
 * "here is how to make one".
 */
export function findDefaultPolicyPath(opts: PolicyLookupOptions = {}): string | undefined {
  const candidates = defaultPolicyCandidates(opts.cwd ?? process.cwd(), opts.journalDir ?? JOURNAL_DIR)
  return candidates.map((candidate) => candidate.path).find((path) => existsSync(path))
}

/** The data directory's policy — the one every server behind mcpcut reads, where the README puts it. */
export function dataPolicyPathOf(opts: PolicyLookupOptions = {}): string {
  return dataDirPolicyPath(opts.cwd ?? process.cwd(), opts.journalDir ?? JOURNAL_DIR)
}
