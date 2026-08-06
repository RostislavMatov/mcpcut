import { loadPolicy, type LoadPolicyOptions, type PolicyLoadResult } from '../policy/load.js'
import { parsePolicy, type Policy } from '../policy/schema.js'

/**
 * Policy resolution for `connect`, and the policy a run gets when no file
 * exists anywhere.
 *
 * `connect` has no "mode A": the agent dimension (grants gate `tools/call`
 * and filter `tools/list`) lives in the policy gate, so every connect session
 * runs through it. What a missing `policy.json` therefore selects is not "no
 * gate" but the *journaling-only* policy below — the closest equivalent of
 * `wrap`'s mode A that still enforces grants:
 *
 *  - `defaultDecision: 'allow'` — grants alone decide what the agent may
 *    call; the operator has not asked for anything stricter;
 *  - `quarantine.enabled: false` — quarantining new tools defaults to ON in
 *    the schema, which would make a freshly-onboarded agent's first call wait
 *    for a human. That contradicts the milestone's own onboarding scenario
 *    (`server add` → `vault set` → `agent create` → `agent grant` → working
 *    call, under 10 minutes) and would be a surprising *default*, not a
 *    decision the operator made. An operator who wants quarantine writes a
 *    policy file — which is exactly the M2 contract.
 *
 * Everything else keeps the schema defaults (`tools/list` hygiene filtering
 * stays on; agent-grant filtering applies regardless of it).
 *
 * A broken or explicitly-named-but-missing policy file is a hard stop, never
 * a fallback to this policy: falling back to allow-all because a security
 * config failed to parse is precisely the failure mode M2 forbade.
 */

/** Minimal writable-stream shape this module needs, so tests can inject capture objects. */
export interface ConnectPolicyIo {
  readonly stderr: { write(chunk: string): unknown }
}

export type ConnectPolicyOutcome =
  | { readonly status: 'resolved'; readonly policy: Policy }
  | { readonly status: 'failed'; readonly exitCode: number }

/** The policy used when no `policy.json` was found: journal everything, let grants decide. */
export function journalingOnlyPolicy(): Policy {
  const result = parsePolicy({
    version: 1,
    defaultDecision: 'allow',
    quarantine: { enabled: false },
  })
  if (!result.ok) {
    // Unreachable: the document above is fixed and schema-valid. Loud rather
    // than a silent fallback, so a schema change cannot quietly alter it.
    throw new Error(`the built-in journaling-only policy is invalid: ${result.error.message}`)
  }
  return result.policy
}

export interface ResolveConnectPolicyArgs {
  /** Value of `--policy`, if given. */
  readonly explicitPath?: string
  readonly io: ConnectPolicyIo
  /** Forwarded to `loadPolicy` unchanged (minus `explicitPath`). */
  readonly loadPolicyOptions?: Omit<LoadPolicyOptions, 'explicitPath'>
}

export async function resolveConnectPolicy(
  args: ResolveConnectPolicyArgs,
): Promise<ConnectPolicyOutcome> {
  const result = await loadPolicy({
    ...args.loadPolicyOptions,
    ...(args.explicitPath !== undefined ? { explicitPath: args.explicitPath } : {}),
  })

  if (result.status === 'error') {
    args.io.stderr.write(formatPolicyLoadErrors(result))
    return { status: 'failed', exitCode: 1 }
  }
  if (result.status === 'disabled') {
    args.io.stderr.write('policy: none found, journaling only (agent grants still apply)\n')
    return { status: 'resolved', policy: journalingOnlyPolicy() }
  }
  args.io.stderr.write(`policy: loaded from ${result.sourcePath}\n`)
  return { status: 'resolved', policy: result.policy }
}

/** `result.errors` are already human-readable lines; each is prefixed with its source path. */
function formatPolicyLoadErrors(result: Extract<PolicyLoadResult, { status: 'error' }>): string {
  return result.errors.map((line) => `${result.sourcePath}: ${line}\n`).join('')
}
