import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { JOURNAL_DIR } from '../config.js'
import { formatReadableField } from '../journal/format.js'
import { POLICY_ENV_VAR, POLICY_FILE_NAME } from '../policy/constants.js'
import { policyHashOf } from '../policy/provenance.js'
import { loadPolicy, PROJECT_POLICY_SUBDIR, type LoadPolicyOptions, type PolicyLoadResult } from '../policy/load.js'
import type { Policy } from '../policy/schema.js'
import {
  ENTRY_POINTS,
  isEntryPoint,
  resolvePolicySource,
  type EntryPoint,
  type ResolvedPolicySource,
} from '../policy/source.js'
import { policyFlagRefusal, policySourceIgnoredNote } from './connect-constants.js'
import { BARE_SHOW_TRUST_CLASS, BARE_SHOW_VIEW_LINES } from './policy-show-constants.js'

/**
 * `policy validate|show` -- operator-facing inspection of the resolved
 * policy file (`policy/load.ts`). Exported as plain functions rather than a
 * `main()`, so `src/cli.ts` can dispatch into them and tests can drive them
 * without touching the real `process.stdout`/`process.stderr` (same shape as
 * `approvals-cmd.ts` / `quarantine-cmd.ts`).
 *
 * `policy show --json` prints the *effective* policy (defaults already
 * applied by `parsePolicy`) -- it exists as the anti-"why is this allowed"
 * tool: an operator staring at a thin `policy.json` on disk cannot see what
 * `approval.timeoutMs` or `quarantine.onQuarantined` actually resolve to
 * without this command.
 */

/** Minimal writable-stream shape these commands need, so tests can inject plain capture objects. */
export interface PolicyCliWritable {
  write(chunk: string): unknown
}

export interface PolicyCliIo {
  readonly stdout: PolicyCliWritable
  readonly stderr: PolicyCliWritable
}

/** Options threaded through to `loadPolicy`, minus `explicitPath` (that comes from CLI args, not test wiring). */
export type PolicyCliOptions = Omit<LoadPolicyOptions, 'explicitPath'>

const DEFAULT_IO: PolicyCliIo = { stdout: process.stdout, stderr: process.stderr }

const VALIDATE_USAGE = `Usage:
  policy validate [path]   Validate the resolved (or explicitly given) policy file
`

const SHOW_USAGE = `Usage:
  policy show [--server <name>] [--json] [--policy <path>] [--entry-point <name>]
                                Print the effective policy (defaults applied).
                                --entry-point ${ENTRY_POINTS.join('|')}
                                resolves the source the way that entry point does
                                (see docs/adr/0005-policy-source-resolution.md)
`

/**
 * `policy validate [path]`: loads the policy (explicit `path` if given,
 * otherwise the normal 4-source resolution) and reports whether it is
 * usable. Never throws -- every `loadPolicy` outcome maps to an exit code.
 */
export async function runPolicyValidate(
  args: string[],
  io: PolicyCliIo = DEFAULT_IO,
  opts: PolicyCliOptions = {},
): Promise<number> {
  let explicitPath: string | undefined
  try {
    const parsed = parseArgs({ args: [...args], options: {}, allowPositionals: true, strict: true })
    explicitPath = parsed.positionals[0]
  } catch {
    io.stderr.write(VALIDATE_USAGE)
    return 1
  }

  const result = await loadPolicy({
    ...opts,
    ...(explicitPath !== undefined ? { explicitPath } : {}),
  })

  return reportValidateResult(result, io, opts)
}

function reportValidateResult(result: PolicyLoadResult, io: PolicyCliIo, opts: PolicyCliOptions): number {
  if (result.status === 'loaded') {
    io.stdout.write(`${result.sourcePath}\nOK\n`)
    return 0
  }
  if (result.status === 'disabled') {
    io.stderr.write(`${formatSearchedLocations(opts, undefined)}\n`)
    return 1
  }
  io.stderr.write(formatErrorLines(result))
  return 1
}

/** `result.errors` are already human-readable lines (see `formatPolicyErrors`); each is prefixed with its source path here. */
function formatErrorLines(result: Extract<PolicyLoadResult, { status: 'error' }>): string {
  return result.errors.map((line) => `${result.sourcePath}: ${line}\n`).join('')
}

/**
 * Explains the 4 locations `loadPolicy` checks, in resolution order, for the
 * "no policy file found" case. Only reachable via default resolution (no
 * `--policy` flag, no `$MCP_JOURNAL_POLICY`): both named sources are
 * "required" in `loadPolicy` and resolve to `status: 'error'` instead of
 * `'disabled'` when missing, so items 1 and 2 below are always "not given" /
 * "not set" whenever this message is shown.
 */
function formatSearchedLocations(
  opts: PolicyCliOptions,
  resolution: ResolvedPolicySource | undefined,
): string {
  if (resolution !== undefined) {
    return formatEntryPointSearch(resolution)
  }

  const cwd = opts.cwd ?? process.cwd()
  const journalDir = opts.journalDir ?? JOURNAL_DIR
  const projectPath = resolve(cwd, join(PROJECT_POLICY_SUBDIR, POLICY_FILE_NAME))
  const homePath = resolve(cwd, join(journalDir, POLICY_FILE_NAME))

  // The project-level candidate is resolved against the CURRENT DIRECTORY, so
  // running from inside `~/.mcp-journal` legitimately produces
  // `~/.mcp-journal/.mcp-journal/policy.json`. That looked like a path bug in
  // the manual M4 smoke because the lines were unlabelled; label them, and
  // print one line when the two candidates are the same file.
  const locations =
    projectPath === homePath
      ? [`  3. ${projectPath} (project-level and home-level are the same path here)`]
      : [`  3. ${projectPath} (project-level, relative to the current directory)`, `  4. ${homePath} (home-level)`]

  return [
    'no policy file found. Searched, in order:',
    '  1. --policy <path> (explicit path flag) -- not given',
    `  2. $${POLICY_ENV_VAR} (environment variable) -- not set`,
    ...locations,
  ].join('\n')
}

/**
 * The "nothing found" view for `--entry-point`: the candidate list comes from
 * the resolution itself, so an `agent-launched` entry point is never shown
 * locations it would refuse to read.
 */
function formatEntryPointSearch(resolution: ResolvedPolicySource): string {
  const searched = resolution.candidates.map(
    (candidate, index) => `  ${index + 1}. ${candidate.path}`,
  )
  const ignored = resolution.ignored.map(
    (source) => `  ignored (${resolution.trustClass} entry point): ${source.descriptor}`,
  )
  return [
    `no policy file found for entry point "${resolution.entryPoint}" (${resolution.trustClass}). Searched, in order:`,
    ...searched,
    ...ignored,
  ].join('\n')
}

/**
 * `policy show [--server <name>] [--json] [--policy <path>]`: prints the
 * effective (defaults-applied) policy. `--json` is the authoritative,
 * machine-readable view; the readable view routes every operator-edited
 * string (server names, tool rule patterns) through `formatReadableField`,
 * same discipline as the journal-readable view in `cli.ts`.
 */
export async function runPolicyShow(
  args: string[],
  io: PolicyCliIo = DEFAULT_IO,
  opts: PolicyCliOptions = {},
): Promise<number> {
  let server: string | undefined
  let json: boolean
  let explicitPath: string | undefined
  let entryPointRaw: string | undefined
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        server: { type: 'string' },
        json: { type: 'boolean', default: false },
        policy: { type: 'string' },
        'entry-point': { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    server = parsed.values.server
    json = parsed.values.json === true
    explicitPath = parsed.values.policy
    entryPointRaw = parsed.values['entry-point']
  } catch {
    io.stderr.write(SHOW_USAGE)
    return 1
  }

  // Validated OUTSIDE the parseArgs catch, so a typo gets an actionable
  // message instead of the generic usage text. The raw name is untrusted CLI
  // input and is deliberately not echoed back.
  if (entryPointRaw !== undefined && !isEntryPoint(entryPointRaw)) {
    io.stderr.write(`--entry-point: expected one of ${ENTRY_POINTS.join(', ')}\n`)
    io.stderr.write(SHOW_USAGE)
    return 1
  }
  const entryPoint: EntryPoint | undefined = entryPointRaw

  const source = await resolveShowSource({ entryPoint, explicitPath }, io, opts)
  if (source.status === 'refused') {
    return 1
  }

  const result = await loadPolicy(source.loadOptions)

  if (result.status === 'disabled') {
    io.stderr.write(`${formatSearchedLocations(opts, source.resolution)}\n`)
    return 1
  }
  if (result.status === 'error') {
    io.stderr.write(formatErrorLines(result))
    return 1
  }

  return reportLoadedShow(result.sourcePath, result.policy, { server, json, resolution: source.resolution }, io)
}

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
async function resolveShowSource(
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
  const resolution = await resolvePolicySource({
    entryPoint: view.entryPoint,
    journalDir,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.readFile !== undefined ? { readFile: opts.readFile } : {}),
    ...(view.explicitPath !== undefined ? { explicitPath: view.explicitPath } : {}),
    notes: { write: (chunk) => io.stderr.write(chunk), render: policySourceIgnoredNote },
  })

  if (resolution.status === 'refused') {
    io.stderr.write(policyFlagRefusal(journalDir))
    return { status: 'refused' }
  }
  return { status: 'resolved', loadOptions: resolution.loadOptions, resolution }
}

interface ShowView {
  readonly server: string | undefined
  readonly json: boolean
  /** Present only when `--entry-point` was given; adds the entry point and its trust class to the output. */
  readonly resolution: ResolvedPolicySource | undefined
}

function reportLoadedShow(
  sourcePath: string,
  policy: Policy,
  view: ShowView,
  io: PolicyCliIo,
): number {
  if (view.server !== undefined && policy.servers?.[view.server] === undefined) {
    io.stderr.write(formatUnknownServer(view.server, policy))
    return 1
  }

  // `--json` gets the label too -- a machine consumer needs it MORE than a
  // human does: it never sees the hint line, and a bare `sourcePath` is
  // indistinguishable from the `connect` answer. `entryPoint` stays absent
  // when none was named (it means "an entry point was asked for"), so
  // existing consumers keying on it are unaffected; no field is renamed.
  const entry =
    view.resolution !== undefined
      ? { entryPoint: view.resolution.entryPoint, trustClass: view.resolution.trustClass }
      : { trustClass: BARE_SHOW_TRUST_CLASS }

  if (view.json) {
    io.stdout.write(`${JSON.stringify({ ...entry, sourcePath, policyHash: policyHashOf(policy), policy })}\n`)
    return 0
  }

  io.stdout.write(formatReadableShow(sourcePath, policy, view.server, view.resolution))
  return 0
}

/**
 * `server` here is the raw `--server` CLI argument, not a value read back
 * from the policy file -- still untrusted (attacker/careless-operator
 * controlled shell input), so it goes through `formatReadableField` before
 * it is echoed back in the error message.
 */
function formatUnknownServer(server: string, policy: Policy): string {
  const known = Object.keys(policy.servers ?? {})
  const knownList = known.length > 0 ? known.map(formatReadableField).join(', ') : '(none defined)'
  return `Unknown server "${formatReadableField(server)}". Known servers: ${knownList}\n`
}

function formatReadableShow(
  sourcePath: string,
  policy: Policy,
  serverFilter: string | undefined,
  resolution: ResolvedPolicySource | undefined,
): string {
  const lines = [
    ...(resolution !== undefined
      ? [`entry point: ${resolution.entryPoint} (${resolution.trustClass})`]
      : BARE_SHOW_VIEW_LINES),
    `source: ${sourcePath}`,
    // Next to `source:` on purpose: the path and the fingerprint answer the
    // same question ("which rules are these"), and the fingerprint is what
    // ties a `decision` record's `policyHash` back to a file. No
    // `formatReadableField` here -- that guard is for operator-edited
    // strings read out of the policy file; this is a hex digest we just
    // computed and its alphabet cannot carry anything to escape.
    `policyHash: ${policyHashOf(policy)}`,
    `defaultDecision: ${policy.defaultDecision}`,
    `classDefaults: ${JSON.stringify(policy.classDefaults ?? {})}`,
    `quarantine: ${JSON.stringify(policy.quarantine)}`,
    `toolsList: ${JSON.stringify(policy.toolsList)}`,
    `approval: ${JSON.stringify(policy.approval)}`,
    `journal: ${JSON.stringify(policy.journal)}`,
    '',
    'servers:',
    ...formatServersSection(policy, serverFilter),
  ]
  return `${lines.join('\n')}\n`
}

function formatServersSection(policy: Policy, serverFilter: string | undefined): string[] {
  const names = serverFilter !== undefined ? [serverFilter] : Object.keys(policy.servers ?? {})
  if (names.length === 0) {
    return ['  (none defined)']
  }
  return names.flatMap((name) => formatServerSection(name, policy.servers?.[name]))
}

type ServerEntry = NonNullable<Policy['servers']>[string]

/** Server names come from a user-edited config file: routed through `formatReadableField` like every other operator-edited string here. */
function formatServerSection(name: string, entry: ServerEntry | undefined): string[] {
  const safeName = formatReadableField(name)
  if (entry === undefined) {
    return [`  ${safeName}: (no explicit rules; uses policy defaults)`]
  }

  const lines = [`  ${safeName}:`]
  if (entry.defaultDecision !== undefined) {
    lines.push(`    defaultDecision: ${entry.defaultDecision}`)
  }
  lines.push(...formatRuleMap('classOverrides', entry.classOverrides))
  lines.push(...formatRuleMap('tools', entry.tools))
  return lines
}

/** Tool rule patterns (map keys) come from the same user-edited config file, so they go through `formatReadableField` too. */
function formatRuleMap<V extends string>(label: string, map: Record<string, V> | undefined): string[] {
  if (map === undefined || Object.keys(map).length === 0) {
    return []
  }
  const entries = Object.entries(map).map(([pattern, value]) => `      ${formatReadableField(pattern)}: ${value}`)
  return [`    ${label}:`, ...entries]
}
