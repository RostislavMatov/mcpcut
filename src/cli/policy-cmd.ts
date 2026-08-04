import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { JOURNAL_DIR } from '../config.js'
import { formatReadableField } from '../journal/format.js'
import { POLICY_ENV_VAR, POLICY_FILE_NAME } from '../policy/constants.js'
import { loadPolicy, PROJECT_POLICY_SUBDIR, type LoadPolicyOptions, type PolicyLoadResult } from '../policy/load.js'
import type { Policy } from '../policy/schema.js'

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
  policy show [--server <name>] [--json] [--policy <path>]   Print the effective policy (defaults applied)
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
    io.stderr.write(`${formatSearchedLocations(opts)}\n`)
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
function formatSearchedLocations(opts: PolicyCliOptions): string {
  const cwd = opts.cwd ?? process.cwd()
  const journalDir = opts.journalDir ?? JOURNAL_DIR
  const projectPath = resolve(cwd, join(PROJECT_POLICY_SUBDIR, POLICY_FILE_NAME))
  const homePath = resolve(cwd, join(journalDir, POLICY_FILE_NAME))

  return [
    'no policy file found. Searched, in order:',
    '  1. --policy <path> (explicit path flag) -- not given',
    `  2. $${POLICY_ENV_VAR} (environment variable) -- not set`,
    `  3. ${projectPath}`,
    `  4. ${homePath}`,
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
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        server: { type: 'string' },
        json: { type: 'boolean', default: false },
        policy: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    server = parsed.values.server
    json = parsed.values.json === true
    explicitPath = parsed.values.policy
  } catch {
    io.stderr.write(SHOW_USAGE)
    return 1
  }

  const result = await loadPolicy({
    ...opts,
    ...(explicitPath !== undefined ? { explicitPath } : {}),
  })

  if (result.status === 'disabled') {
    io.stderr.write(`${formatSearchedLocations(opts)}\n`)
    return 1
  }
  if (result.status === 'error') {
    io.stderr.write(formatErrorLines(result))
    return 1
  }

  return reportLoadedShow(result.sourcePath, result.policy, { server, json }, io)
}

function reportLoadedShow(
  sourcePath: string,
  policy: Policy,
  view: { readonly server: string | undefined; readonly json: boolean },
  io: PolicyCliIo,
): number {
  if (view.server !== undefined && policy.servers?.[view.server] === undefined) {
    io.stderr.write(formatUnknownServer(view.server, policy))
    return 1
  }

  if (view.json) {
    io.stdout.write(`${JSON.stringify({ sourcePath, policy })}\n`)
    return 0
  }

  io.stdout.write(formatReadableShow(sourcePath, policy, view.server))
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

function formatReadableShow(sourcePath: string, policy: Policy, serverFilter: string | undefined): string {
  const lines = [
    `source: ${sourcePath}`,
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
