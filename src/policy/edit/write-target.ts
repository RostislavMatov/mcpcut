import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { POLICY_FILE_NAME } from '../constants.js'
import { resolvePolicySource, type PolicySourceCandidate } from '../source.js'

/**
 * Which file a policy edit (admin UI, `policy set`) writes, and who reads it.
 *
 * **The edit lands in the file the entry point itself loaded** (owner
 * decision 2026-08-26, ADR-0009 "Поправка 2026-08-26"): the first candidate
 * of the operator-launched order (ADR-0005) resolved from THIS process's env
 * and cwd — the very path `resolvePolicySource` + `loadPolicy` give the `ui`
 * process. Hard-wiring `<journalDir>/policy.json` was wrong on any install
 * whose plane really enforces a project-level file: the card called itself
 * policy-less and disabled every control while rules were being enforced
 * from a file two directories away.
 *
 * The path is still fixed by the process, never by a request: `env` and `cwd`
 * come from the composition root (the operator's own shell — the same trust
 * class ADR-0005 grants `ui`/`wrap`/`serve`), and no field of an HTTP request
 * reaches this module.
 *
 * Since an edit can now land in a file `connect` does not read, the target
 * carries a computed statement of WHO reads it. `connect` (agent-launched)
 * reads `<journalDir>/.mcp-journal/policy.json` and then
 * `<journalDir>/policy.json`, and nothing else; every operator-launched entry
 * reads the four-source order. That statement is displayed — never a refusal:
 * an edit always reaches the entries that loaded the file it changes.
 */

/** Every operator-launched entry shares one source order; `ui` stands for all of them. */
const OPERATOR_ENTRY_POINT = 'ui'

/** The one agent-launched entry, and the only reader that can differ from the target. */
const AGENT_ENTRY_POINT = 'connect'

/** Who loads the file an edit writes. Computed from the two source orders, never guessed. */
export type PolicyTargetReaders =
  /** The target is also what `connect` loads: one file, every entry point. */
  | { readonly kind: 'every-entry-point' }
  /** `connect` loads another EXISTING file; `shadowsTarget` when it precedes the target in its own order. */
  | { readonly kind: 'connect-elsewhere'; readonly connectPath: string; readonly shadowsTarget: boolean }
  /** No file exists where `connect` looks: agent sessions run journaling-only. */
  | { readonly kind: 'connect-unset' }

export interface PolicyEditTarget {
  /** Absolute path of the file to edit. Absent on disk means "would be created there" — the caller still refuses (O4). */
  readonly path: string
  readonly readers: PolicyTargetReaders
}

export interface PolicyEditTargetArgs {
  /** The plane's state directory: the last candidate, and the root of `connect`'s own order. */
  readonly journalDir: string
  /** Environment of the editing process. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Working directory of the editing process. Defaults to `process.cwd()`. */
  readonly cwd?: string
}

export interface PolicyEditTargetDeps {
  /** Whether a file exists at `path`. Defaults to `fs.access`. */
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

export const defaultPolicyEditTargetDeps: PolicyEditTargetDeps = { exists: defaultExists }

export async function resolvePolicyEditTarget(
  args: PolicyEditTargetArgs,
  deps: PolicyEditTargetDeps = defaultPolicyEditTargetDeps,
): Promise<PolicyEditTarget> {
  const stateFile = join(args.journalDir, POLICY_FILE_NAME)
  const operator = await candidatesOf({
    entryPoint: OPERATOR_ENTRY_POINT,
    journalDir: args.journalDir,
    env: args.env ?? process.env,
    cwd: args.cwd ?? process.cwd(),
  })
  // `connect` neutralizes env and cwd itself (ADR-0005); passing the neutral
  // pair keeps this call free of the caller's environment either way.
  const agent = await candidatesOf({
    entryPoint: AGENT_ENTRY_POINT,
    journalDir: args.journalDir,
    env: {},
    cwd: args.journalDir,
  })

  const path = (await firstLoaded(operator, deps)) ?? stateFile
  const connectPath = await firstLoaded(agent, deps)
  return { path, readers: readersOf(path, connectPath, stateFile) }
}

/** The one wording of "who reads the file you are editing", shared by the Servers card and `policy set`. */
export function describePolicyReaders(readers: PolicyTargetReaders): string {
  if (readers.kind === 'every-entry-point') return 'every entry point reads this file'
  if (readers.kind === 'connect-unset') {
    return (
      'ui/wrap/serve read this file; connect sessions have no policy right now (journaling only) ' +
      '— rules here do not reach them'
    )
  }
  if (readers.shadowsTarget) {
    return `connect reads ${readers.connectPath} first — rules here reach ui/wrap/serve only`
  }
  return `ui/wrap/serve read this file; connect sessions read ${readers.connectPath}`
}

/** The `policy set --json` projection: additive fields only, so the existing shape stays stable. */
export interface PolicyReadersJson {
  readonly connect: boolean
  readonly connectPath: string | null
  /** Always true: an operator-launched entry started here loads the target by construction. */
  readonly operator: true
}

export function policyReadersJson(readers: PolicyTargetReaders): PolicyReadersJson {
  if (readers.kind === 'every-entry-point') return { connect: true, connectPath: null, operator: true }
  if (readers.kind === 'connect-unset') return { connect: false, connectPath: null, operator: true }
  return { connect: false, connectPath: readers.connectPath, operator: true }
}

/**
 * With no file anywhere, `connect` would read the state-dir file — the same
 * one the target falls back to — so the statement stays "every entry point".
 */
function readersOf(path: string, connectPath: string | undefined, stateFile: string): PolicyTargetReaders {
  if (samePath(connectPath ?? stateFile, path)) return { kind: 'every-entry-point' }
  if (connectPath === undefined) return { kind: 'connect-unset' }
  return { kind: 'connect-elsewhere', connectPath, shadowsTarget: samePath(path, stateFile) }
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right)
}

/**
 * The first candidate that entry point would actually load. A source the
 * operator named explicitly (`--policy`, `$MCP_JOURNAL_POLICY`) is that file
 * whether or not it exists: the entry point loads that path or fails, and
 * never falls through. A probe that throws counts as "not there" — the walk
 * then reaches the plane's own state directory, the safest place to land.
 */
async function firstLoaded(
  candidates: readonly PolicySourceCandidate[],
  deps: PolicyEditTargetDeps,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (candidate.required) return candidate.path
    if (await probeExists(candidate.path, deps)) return candidate.path
  }
  return undefined
}

async function probeExists(path: string, deps: PolicyEditTargetDeps): Promise<boolean> {
  try {
    return await deps.exists(path)
  } catch {
    return false
  }
}

/**
 * ADR-0005 owns both orders; this module never rebuilds them. A refusal is
 * unreachable here (only `connect` with `--policy` refuses, and no caller
 * passes one), so it degrades to "no candidates" rather than throwing.
 */
async function candidatesOf(args: {
  readonly entryPoint: typeof OPERATOR_ENTRY_POINT | typeof AGENT_ENTRY_POINT
  readonly journalDir: string
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
}): Promise<readonly PolicySourceCandidate[]> {
  const resolved = await resolvePolicySource(args)
  return resolved.status === 'resolved' ? resolved.candidates : []
}
