import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import { PROJECT_POLICY_SUBDIR } from '../policy/load.js'
import { POLICY_FILE_NAME } from '../policy/constants.js'

export interface PolicyLookupOptions {
  readonly cwd?: string
  readonly journalDir?: string
}

/**
 * The policy file `wrap` would pick up on its own (no `--policy`, no
 * `MCPCUT_POLICY`): the project folder's first, then the data directory's —
 * the same two places, in the same order, as `policy/load.ts`. `undefined`
 * when neither exists, which is what an empty `approvals list` turns into
 * "here is how to make one".
 */
export function findDefaultPolicyPath(opts: PolicyLookupOptions = {}): string | undefined {
  const cwd = opts.cwd ?? process.cwd()
  const candidates = [
    resolve(cwd, join(PROJECT_POLICY_SUBDIR, POLICY_FILE_NAME)),
    resolve(cwd, join(opts.journalDir ?? JOURNAL_DIR, POLICY_FILE_NAME)),
  ]
  return candidates.find((path) => existsSync(path))
}
