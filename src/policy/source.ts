import { access, constants as fsConstants } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { JOURNAL_DIR } from '../config.js'
import { POLICY_ENV_VAR, POLICY_FILE_NAME } from './constants.js'
import { PROJECT_POLICY_SUBDIR, type LoadPolicyOptions } from './load.js'

/**
 * **The policy source is decided by the entry point's trust class, not by the
 * entry point itself** (ADR-0005, `docs/adr/0005-policy-source-resolution.md`).
 * This module is the single place that rule is written down; before M4 it
 * lived as a comment in `cli/connect-policy.ts` and nowhere else, which is
 * exactly why the manual smoke of 2026-08-10 read the `connect`/`serve`
 * asymmetry as accidental.
 *
 * Two classes, and every entry point belongs to one of them:
 *
 *  - **`agent-launched`** — the process is started by the AGENT's own config
 *    (`.mcp.json`), so argv, `cwd` and the environment are the untrusted side
 *    of the boundary: they are controlled by the very party the policy
 *    constrains. Such an entry point reads the policy from the plane's state
 *    directory ONLY. Agent-controlled sources are *neutralized*, not merely
 *    deprioritized — deprioritizing leaves them live wherever no higher-ranked
 *    candidate exists.
 *  - **`operator-launched`** — the process is started by a human operator from
 *    their own shell, so argv/`cwd`/env are as trusted as the launch itself.
 *    Such an entry point keeps the full four-source order of `policy/load.ts`,
 *    unchanged.
 *
 * This module resolves the SOURCE; `loadPolicy` still does the reading, from
 * the `loadOptions` returned here. The operator-facing wording of the notes
 * stays in the CLI layer that owns the command's UX (see `PolicySourceNotes`):
 * this module owns the rule, not the prose.
 */

/** Every process that may enforce or display a policy. Adding one requires giving it a trust class below. */
export type EntryPoint = 'connect' | 'wrap' | 'serve' | 'ui'

/** Who controls argv, `cwd` and the environment of a running entry point. */
export type TrustClass = 'agent-launched' | 'operator-launched'

/**
 * The rule, as a table. Exhaustive by type: a new `EntryPoint` member does not
 * compile until its trust class is decided here, so an entry point can never
 * inherit a source order by precedent (ADR-0005, "Когда пересматриваем").
 */
export const ENTRY_POINT_TRUST: Readonly<Record<EntryPoint, TrustClass>> = {
  // Started by the agent's client config.
  connect: 'agent-launched',
  // Started by the operator's shell / unit file.
  wrap: 'operator-launched',
  serve: 'operator-launched',
  ui: 'operator-launched',
}

export const ENTRY_POINTS: readonly EntryPoint[] = Object.keys(ENTRY_POINT_TRUST) as EntryPoint[]

/** Narrows untrusted CLI input (`--entry-point <name>`) to a known entry point. */
export function isEntryPoint(value: string): value is EntryPoint {
  return Object.prototype.hasOwnProperty.call(ENTRY_POINT_TRUST, value)
}

export function trustClassOf(entryPoint: EntryPoint): TrustClass {
  return ENTRY_POINT_TRUST[entryPoint]
}

/** One agent-controlled source that exists and was ignored, in the order it would have been consulted. */
export interface IgnoredPolicySource {
  readonly kind: 'env' | 'project'
  /** How the source is named to the operator: `$MCPCUT_POLICY`, or the absolute project path. */
  readonly descriptor: string
}

/** One location that will be tried, in resolution order. */
export interface PolicySourceCandidate {
  readonly path: string
  /** `true` for a source the operator named explicitly: a missing file there is an error, not a fallthrough. */
  readonly required: boolean
}

/**
 * Where the one-line-per-ignored-source notes go, and how they are worded.
 * Injected rather than built in: the sink differs per entry point (`connect`
 * must use stderr — its stdout is the protocol channel) and the wording is
 * operator-facing UX owned by the CLI layer (`cli/connect-constants.ts`).
 * Omitting it resolves silently; `ignored` is reported either way.
 */
export interface PolicySourceNotes {
  readonly write: (chunk: string) => unknown
  readonly render: (source: string, journalDir: string) => string
}

export interface ResolvePolicySourceArgs {
  readonly entryPoint: EntryPoint
  /** The plane's state directory. Defaults to `JOURNAL_DIR`. */
  readonly journalDir?: string
  /** Environment the entry point was started with. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Working directory the entry point was started in. Defaults to `process.cwd()`. */
  readonly cwd?: string
  /** Value of `--policy`, if given. Refused on an `agent-launched` entry point. */
  readonly explicitPath?: string
  /** Test seam, threaded through to `loadPolicy` and used to probe ignored sources. */
  readonly readFile?: LoadPolicyOptions['readFile']
  /** Sink + wording for the ignored-source notes. Omitted = resolve silently. */
  readonly notes?: PolicySourceNotes
}

export interface ResolvedPolicySource {
  readonly status: 'resolved'
  readonly entryPoint: EntryPoint
  readonly trustClass: TrustClass
  /** Hand straight to `loadPolicy`: the trust-class rule is already baked in. */
  readonly loadOptions: LoadPolicyOptions
  readonly candidates: readonly PolicySourceCandidate[]
  readonly ignored: readonly IgnoredPolicySource[]
}

export interface RefusedPolicySource {
  readonly status: 'refused'
  readonly entryPoint: EntryPoint
  readonly trustClass: TrustClass
  readonly reason: typeof EXPLICIT_PATH_REFUSAL_REASON
}

export type PolicySourceResolution = ResolvedPolicySource | RefusedPolicySource

/**
 * The only refusal this module produces: a policy path chosen on the command
 * line of a process the agent itself launches would let the agent pick the
 * rules it is judged by.
 */
export const EXPLICIT_PATH_REFUSAL_REASON = 'explicit-path-on-agent-launched-entry'

export async function resolvePolicySource(
  args: ResolvePolicySourceArgs,
): Promise<PolicySourceResolution> {
  const { entryPoint } = args
  const trustClass = trustClassOf(entryPoint)
  const journalDir = args.journalDir ?? JOURNAL_DIR
  const env = args.env ?? process.env
  const cwd = args.cwd ?? process.cwd()
  const readFileOption = args.readFile !== undefined ? { readFile: args.readFile } : {}

  if (trustClass === 'operator-launched') {
    return {
      status: 'resolved',
      entryPoint,
      trustClass,
      loadOptions: {
        ...(args.explicitPath !== undefined ? { explicitPath: args.explicitPath } : {}),
        env,
        cwd,
        journalDir,
        ...readFileOption,
      },
      candidates: candidatesOf({ explicitPath: args.explicitPath, env, cwd, journalDir }),
      ignored: [],
    }
  }

  if (args.explicitPath !== undefined) {
    // Refused by its nature, before anything is probed: a refusal that depends
    // on where the path points is a refusal an attacker gets to probe.
    return { status: 'refused', entryPoint, trustClass, reason: EXPLICIT_PATH_REFUSAL_REASON }
  }

  const ignored = await findIgnoredSources({ env, cwd, readFile: args.readFile })
  writeNotes(ignored, journalDir, args.notes)

  return {
    status: 'resolved',
    entryPoint,
    trustClass,
    // Neutralization: an empty environment removes `$MCPCUT_POLICY`, and a
    // `cwd` pointing at the state directory keeps `loadPolicy`'s project-level
    // candidate inside the operator's own directory too.
    loadOptions: { env: {}, cwd: journalDir, journalDir, ...readFileOption },
    candidates: candidatesOf({ explicitPath: undefined, env: {}, cwd: journalDir, journalDir }),
    ignored,
  }
}

/**
 * Mirrors `loadPolicy`'s own resolution order so operators can be shown the
 * exact list that will be tried. Pinned to the loader by
 * `tests/policy/load.test.ts` ("advertised candidates match what loadPolicy
 * actually reads"), since the two live in separate modules.
 */
function candidatesOf(args: {
  readonly explicitPath: string | undefined
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  readonly journalDir: string
}): readonly PolicySourceCandidate[] {
  const { explicitPath, env, cwd, journalDir } = args

  if (explicitPath !== undefined) {
    return [{ path: resolveCandidate(cwd, explicitPath), required: true }]
  }

  const envValue = env[POLICY_ENV_VAR]
  if (envValue !== undefined) {
    return [{ path: resolveCandidate(cwd, envValue), required: true }]
  }

  return [
    { path: resolveCandidate(cwd, join(PROJECT_POLICY_SUBDIR, POLICY_FILE_NAME)), required: false },
    { path: resolveCandidate(cwd, join(journalDir, POLICY_FILE_NAME)), required: false },
  ]
}

/**
 * `path.resolve` for every value that can be resolved, and the raw value for
 * the two `loadPolicy` rejects outright (empty, or containing a null byte) --
 * showing an operator `""` resolved to their cwd would hide the very
 * misconfiguration `loadPolicy` is about to report.
 */
function resolveCandidate(cwd: string, value: string): string {
  if (value.length === 0 || value.includes('\0')) {
    return value
  }
  // `path.resolve` output is absolute by contract; no result union needed here.
  return resolve(cwd, value)
}

/**
 * The agent-controlled sources that exist and are being ignored, in resolution
 * order. Existence matters: a note printed on every run is a note operators
 * learn to skip (ADR-0005). `$MCPCUT_POLICY` counts as present whenever
 * it is set at all -- an empty or unreadable value is still an override the
 * operator wrote and expects to have an effect.
 */
async function findIgnoredSources(args: {
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  readonly readFile: LoadPolicyOptions['readFile'] | undefined
}): Promise<readonly IgnoredPolicySource[]> {
  const ignored: IgnoredPolicySource[] = []

  if (args.env[POLICY_ENV_VAR] !== undefined) {
    ignored.push({ kind: 'env', descriptor: `$${POLICY_ENV_VAR}` })
  }

  const projectPath = join(args.cwd, PROJECT_POLICY_SUBDIR, POLICY_FILE_NAME)
  if (await isReadable(projectPath, args.readFile)) {
    ignored.push({ kind: 'project', descriptor: projectPath })
  }

  return ignored
}

function writeNotes(
  ignored: readonly IgnoredPolicySource[],
  journalDir: string,
  notes: PolicySourceNotes | undefined,
): void {
  if (notes === undefined) return
  for (const source of ignored) {
    notes.write(notes.render(source.descriptor, journalDir))
  }
}

/**
 * Existence/readability probe for the ignored-source note. The default path
 * uses `fs.access` — this file is agent-controlled and only a NOTE depends on
 * it, so its content must never be read into memory here (review M2). An
 * injected `readFile` (the test seam shared with `loadPolicy`) is still
 * honored so tests control the probe the same way they control the loader.
 */
async function isReadable(
  path: string,
  readFile: LoadPolicyOptions['readFile'] | undefined,
): Promise<boolean> {
  try {
    if (readFile !== undefined) {
      await readFile(path)
      return true
    }
    await access(path, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}
