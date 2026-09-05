import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  CLI_NAME,
  CONFIG_PATH_ENV_VAR,
  DATA_DIR_ENV_VAR,
  DEFAULT_DATA_DIR_NAME,
} from './constants.js'
import { loadInstallConfigSync, type InstallConfigLoad } from './load.js'

/**
 * Where this process keeps its data (phase 1, task 4) — the one question
 * `src/config.ts` answers at import, for every command in the process.
 *
 * The ranking is `MCP_JOURNAL_DIR` > the install config's `dataDir` >
 * `~/.mcp-journal`, so an install that never ran `setup` and exports nothing
 * lands on exactly the path it has always used. Per-command flags rank above
 * all three, but they are each command's own business, not this module's.
 *
 * A config that cannot be read is NOT a fatal event here: it is returned as
 * `problem`, a value the dispatcher prints before refusing (fail closed —
 * never a silent fall back to `$HOME` when an operator did write a config).
 * Throwing at module-evaluation time would kill the process before even
 * `--help` could explain what is wrong.
 *
 * IMPORT INVARIANT: `zod`, `node:*` and `../cli/serve-constants.js` only —
 * see the header of `./constants.ts`.
 */

export interface DataDirResolution {
  /** Absolute path of the data directory this process will use. */
  readonly dataDir: string
  /** Which of the three sources answered. */
  readonly source: 'env' | 'config' | 'default'
  /** Where the install config was looked for, whether or not it was usable. */
  readonly configPath: string
  /** Why the resolution is not what the operator asked for, one line per fault. */
  readonly problem?: readonly string[]
  /**
   * Which input the first problem is about, so the refusal can point at the
   * thing that is actually broken: an unusable config file is fixed one way,
   * a malformed `MCP_JOURNAL_DIR` another. Absent when there is no problem.
   */
  readonly problemSource?: 'env' | 'config'
}

export interface ResolveDataDirOptions {
  /** Environment carrying `MCP_JOURNAL_DIR`/`MCPCUT_CONFIG`. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Home directory the default path is built from. Defaults to `homedir()`. */
  readonly home?: string
  /** Pre-read config, so a caller (and `config.ts`) reads the file exactly once. */
  readonly load?: InstallConfigLoad
}

/** Resolves the data directory and reports an unusable config; never throws. */
export function resolveDataDir(opts: ResolveDataDirOptions = {}): DataDirResolution {
  const env = opts.env ?? process.env
  const load =
    opts.load ??
    loadInstallConfigSync({ env, ...(opts.home !== undefined ? { home: opts.home } : {}) })

  const configProblems = load.kind === 'invalid' ? load.problems : []
  const fallback = { dataDir: join(opts.home ?? homedir(), DEFAULT_DATA_DIR_NAME) } as const

  // An override answers WHERE the data lives, but it does not make a broken
  // config well: the operator who wrote that file also meant its bind
  // addresses to apply, and every command should say so once, loudly.
  const override = env[DATA_DIR_ENV_VAR]
  if (override !== undefined && override !== '') {
    if (isAbsolute(override)) {
      return {
        dataDir: override,
        source: 'env',
        configPath: load.path,
        ...problemFields('config', configProblems),
      }
    }
    // A relative override is refused rather than resolved against the working
    // directory: the config field it outranks must be absolute, and a value
    // that means a different directory in every shell would put each command
    // on its own empty, policy-less (journaling-only) plane.
    return {
      ...fallback,
      source: 'default',
      configPath: load.path,
      ...problemFields('env', [relativeOverrideProblem(override), ...configProblems]),
    }
  }

  if (load.kind === 'ok') {
    return { dataDir: load.config.dataDir, source: 'config', configPath: load.path }
  }

  return {
    ...fallback,
    source: 'default',
    configPath: load.path,
    ...problemFields('config', configProblems),
  }
}

/**
 * The value is echoed as it was written, and deliberately NOT through
 * `formatReadableField`: this module runs while `src/config.ts` evaluates and
 * may import nothing but `zod`, `node:*` and its own siblings (see the header
 * of `./constants.ts`). What it echoes is the operator's own environment,
 * already visible in their shell.
 */
function relativeOverrideProblem(override: string): string {
  return `${DATA_DIR_ENV_VAR} must be an absolute path (got "${override}")`
}

/** Both problem fields, or neither: a resolution never carries one without the other. */
function problemFields(
  source: 'env' | 'config',
  problems: readonly string[],
): Pick<DataDirResolution, 'problem' | 'problemSource'> {
  return problems.length === 0 ? {} : { problem: problems, problemSource: source }
}

/**
 * The refusal a command prints when the install config is unusable: what is
 * broken, where it lives, and the two ways out (edit it, or point
 * `MCPCUT_CONFIG` elsewhere / rewrite it). Same shape as the refusals in
 * `src/cli/admin-token.ts` — state the fault, then the way forward.
 *
 * `undefined` when there is nothing to say, so a caller can treat "no problem"
 * and "here is the problem" as one branch.
 */
export function describeDataDirProblem(resolution: DataDirResolution): string | undefined {
  const problems = resolution.problem
  if (problems === undefined || problems.length === 0) return undefined
  const detail = problems.map((problem) => `  ${problem}`).join('\n')
  if (resolution.problemSource === 'env') {
    return (
      `${CLI_NAME}: ${DATA_DIR_ENV_VAR} is not usable:\n${detail}\n` +
      `Export an absolute path, or unset ${DATA_DIR_ENV_VAR} and let the install config ` +
      `${resolution.configPath} answer instead.\n`
    )
  }
  return (
    `${CLI_NAME}: install config ${resolution.configPath} is unusable:\n${detail}\n` +
    `Fix or remove it, or point ${CONFIG_PATH_ENV_VAR} at another file. ` +
    `"${CLI_NAME} setup --yes --force" rewrites it.\n`
  )
}
