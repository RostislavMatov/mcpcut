import { loadPolicy, type LoadPolicyOptions, type PolicyLoadResult } from '../policy/load.js'
import type { PolicyProvider } from '../policy/reload.js'
import { resolvePolicySource } from '../policy/source.js'
import { parsePolicy, type Policy } from '../policy/schema.js'
import {
  EXIT_CODE_REFUSED,
  policyFlagRefusal,
  policySourceIgnoredNote,
} from './connect-constants.js'
import { createAwaitingPolicy, createReloadingPolicy } from './policy-reload.js'

/**
 * Policy resolution for `connect`, and the policy a run gets when no file
 * exists in the operator's directory.
 *
 * **The policy source is operator-controlled, never agent-controlled.**
 * `connect` is launched BY the agent's own client config (`.mcp.json`), so
 * argv, `cwd` and the environment are all the untrusted side of this boundary:
 * `--policy /tmp/allow-all.json` would otherwise neutralize approvals and
 * quarantine with one line in a config the agent already controls (grants
 * would still hold — they live in `agents.json` — but everything policy
 * decides would not).
 *
 * That rule is not this file's to state: `connect` is simply the
 * `agent-launched` entry point, and `policy/source.ts` decides what such an
 * entry point may read (ADR-0005). What stays here is what only `connect`
 * knows — the wording of its refusal and notes, the stream they go to (stderr:
 * stdout is the protocol channel), and the policy a run gets when the state
 * directory holds no file.
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
 * A broken policy file is a hard stop, never a fallback to this policy:
 * falling back to allow-all because a security config failed to parse is
 * precisely the failure mode M2 forbade.
 *
 * A loaded file is handed over as a hot-reloading provider (wave 2 of the
 * policy-tool-rules-ui plan): the session re-reads it when it changes on
 * disk, through the SAME neutralized `loadOptions` resolved here, so the
 * agent-launched trust class keeps holding for the life of the process.
 *
 * The journaling-only fallback WAITS for a file (owner decision 2026-09-18,
 * smoke finding M1; it used to be static, "an explicit operator act plus a
 * restart"): writing the policy is the explicit act, and a long-lived session
 * that kept allowing everything after it was the surprise. The first valid
 * file to appear in the state directory -- the only place this trust class
 * reads -- is adopted; a broken one is reported and never adopted.
 */

/** Minimal writable-stream shape this module needs, so tests can inject capture objects. */
export interface ConnectPolicyIo {
  readonly stderr: { write(chunk: string): unknown }
}

export type ConnectPolicyOutcome =
  | { readonly status: 'resolved'; readonly policy: PolicyProvider }
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
  readonly io: ConnectPolicyIo
  /**
   * The plane's state directory — the ONLY place a connect session accepts a
   * policy from. Both locations `loadPolicy` then considers resolve inside it.
   */
  readonly journalDir: string
  /** Value of `--policy`, if given. Always a refusal; see the module doc. */
  readonly explicitPath?: string
  /** The environment `connect` was started with; read only to note an ignored override. */
  readonly env?: NodeJS.ProcessEnv
  /**
   * The agent-supplied working directory; read only to note an ignored project
   * policy. Omitted means `process.cwd()` — the directory this process was
   * actually started in, which is the one the note is about.
   */
  readonly cwd?: string
  /** Test seam: reads a file as UTF-8 text. Defaults to `node:fs/promises` `readFile`. */
  readonly readFile?: LoadPolicyOptions['readFile']
}

export async function resolveConnectPolicy(
  args: ResolveConnectPolicyArgs,
): Promise<ConnectPolicyOutcome> {
  const source = await resolvePolicySource({
    entryPoint: 'connect',
    journalDir: args.journalDir,
    ...(args.env !== undefined ? { env: args.env } : {}),
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    ...(args.explicitPath !== undefined ? { explicitPath: args.explicitPath } : {}),
    ...(args.readFile !== undefined ? { readFile: args.readFile } : {}),
    notes: {
      write: (chunk) => args.io.stderr.write(chunk),
      render: policySourceIgnoredNote,
    },
  })

  if (source.status === 'refused') {
    args.io.stderr.write(policyFlagRefusal(args.journalDir))
    return { status: 'failed', exitCode: EXIT_CODE_REFUSED }
  }

  const result = await loadPolicy(source.loadOptions)

  if (result.status === 'error') {
    args.io.stderr.write(formatPolicyLoadErrors(result))
    return { status: 'failed', exitCode: 1 }
  }
  if (result.status === 'disabled') {
    args.io.stderr.write('policy: none found, journaling only (agent grants still apply)\n')
    return {
      status: 'resolved',
      policy: createAwaitingPolicy({
        fallback: journalingOnlyPolicy(),
        loadOptions: source.loadOptions,
        candidates: source.candidates,
        stderr: args.io.stderr,
      }),
    }
  }
  args.io.stderr.write(`policy: loaded from ${result.sourcePath}\n`)
  return {
    status: 'resolved',
    policy: createReloadingPolicy({
      initial: result.policy,
      sourcePath: result.sourcePath,
      loadOptions: source.loadOptions,
      candidates: source.candidates,
      stderr: args.io.stderr,
    }),
  }
}

/** `result.errors` are already human-readable lines; each is prefixed with its source path. */
function formatPolicyLoadErrors(result: Extract<PolicyLoadResult, { status: 'error' }>): string {
  return result.errors.map((line) => `${result.sourcePath}: ${line}\n`).join('')
}
