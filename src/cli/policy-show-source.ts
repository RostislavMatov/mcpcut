import { JOURNAL_DIR } from '../config.js'
import type { LoadPolicyOptions } from '../policy/load.js'
import { resolvePolicySource, type EntryPoint, type ResolvedPolicySource } from '../policy/source.js'
import { resolveServeDefaults } from '../setup/bind.js'
import { loadInstallConfigSync } from '../setup/load.js'
import { policyFlagRefusal, policySourceIgnoredNote } from './connect-constants.js'
import type { PolicyCliIo, PolicyCliOptions } from './policy-cmd.js'

/**
 * Which policy file `policy show` is about to print — the one question the
 * command cannot answer by itself, because the answer belongs to whichever
 * entry point the operator asked about (ADR-0005).
 *
 * Split from `policy-cmd.ts` for the file-size budget. The types it needs from
 * that module are imported as TYPES only, so the pair has exactly one runtime
 * edge (command → source) rather than a cycle.
 */

type ShowSource =
  | { readonly status: 'refused' }
  | {
      readonly status: 'resolved'
      readonly loadOptions: LoadPolicyOptions
      readonly resolution: ResolvedPolicySource | undefined
    }

/**
 * Without `--entry-point`, `policy show` resolves the way it always has (this
 * command is itself operator-launched). With it, resolution is delegated to
 * `policy/source.ts` so the printed source is the one that entry point would
 * really load -- including its refusals and its ignored-source notes, which is
 * the whole point of the flag (ADR-0005).
 */
export async function resolveShowSource(
  view: { readonly entryPoint: EntryPoint | undefined; readonly explicitPath: string | undefined },
  io: PolicyCliIo,
  opts: PolicyCliOptions,
): Promise<ShowSource> {
  if (view.entryPoint === undefined) {
    return {
      status: 'resolved',
      loadOptions: { ...opts, ...(view.explicitPath !== undefined ? { explicitPath: view.explicitPath } : {}) },
      resolution: undefined,
    }
  }

  const journalDir = opts.journalDir ?? JOURNAL_DIR
  const explicitPath = view.explicitPath ?? installPolicyPath(view.entryPoint, opts)
  const resolution = await resolvePolicySource({
    entryPoint: view.entryPoint,
    journalDir,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.readFile !== undefined ? { readFile: opts.readFile } : {}),
    ...(explicitPath !== undefined ? { explicitPath } : {}),
    notes: { write: (chunk) => io.stderr.write(chunk), render: policySourceIgnoredNote },
  })

  if (resolution.status === 'refused') {
    io.stderr.write(policyFlagRefusal(journalDir))
    return { status: 'refused' }
  }
  return { status: 'resolved', loadOptions: resolution.loadOptions, resolution }
}

/**
 * The policy path the install config gives `serve`, when the operator did not
 * pass `--policy`.
 *
 * `serve` takes `serve.policy` from the install config into its own `--policy`
 * slot, so a `policy show --entry-point serve` that did not know about that
 * source would confidently name a file `serve` does not read (TS-M7). No other
 * entry point has such a source: `connect`, `wrap` and `ui` are not configured
 * by the install file.
 */
function installPolicyPath(entryPoint: EntryPoint, opts: PolicyCliOptions): string | undefined {
  if (entryPoint !== 'serve') return undefined
  const env = opts.env ?? process.env
  const install = opts.install ?? loadInstallConfigSync({ env })
  return resolveServeDefaults(env, install).policy
}
