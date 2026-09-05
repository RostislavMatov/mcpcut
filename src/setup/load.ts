import { readFileSync as fsReadFileSync, statSync as fsStatSync } from 'node:fs'
import { errnoCodeOf } from '../errno.js'
import { installConfigPath } from './config-path.js'
import { MAX_CONFIG_BYTES } from './constants.js'
import { formatInstallConfigErrors, installConfigSchema, type InstallConfig } from './schema.js'

/**
 * Reading the install config (phase 1, task 3).
 *
 * Synchronous on purpose: `src/config.ts` resolves `JOURNAL_DIR` while it is
 * being evaluated, and every module that imports it expects a string, not a
 * promise. The read therefore happens once per process, at import.
 *
 * Nothing here throws. A missing file is the normal case (an install that
 * never ran `setup` behaves exactly as it always did), and an unusable one is
 * a value the dispatcher can print and refuse on — an exception at
 * module-evaluation time would abort the process before any command, `--help`
 * included, could explain itself.
 *
 * IMPORT INVARIANT: `zod`, `node:*`, the import-free `../errno.js` and
 * `../cli/serve-constants.js` only — see the header of `./constants.ts`.
 */

/** The two facts the pre-read gate needs; `node:fs`'s `Stats` supplies both. */
export interface ConfigFileStat {
  isFile(): boolean
  readonly size: number
}

export type InstallConfigLoad =
  | { readonly kind: 'absent'; readonly path: string }
  | { readonly kind: 'ok'; readonly path: string; readonly config: InstallConfig }
  | { readonly kind: 'invalid'; readonly path: string; readonly problems: readonly string[] }

export interface LoadInstallConfigOptions {
  /** Environment to read `MCPCUT_CONFIG` from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Home directory the default path is built from. Defaults to `homedir()`. */
  readonly home?: string
  /** Reader seam; the default is `node:fs`'s. Tests inject read faults through it. */
  readonly readFileSync?: (path: string) => string
  /**
   * Stat seam, paired with `readFileSync`. It runs FIRST: `MCPCUT_CONFIG`
   * names a path this process did not choose, and `readFileSync` on a FIFO
   * blocks forever — here, at import time, in every command of the process.
   */
  readonly statSync?: (path: string) => ConfigFileStat
}

/** Locates and validates the install config; never throws. */
export function loadInstallConfigSync(opts: LoadInstallConfigOptions = {}): InstallConfigLoad {
  const env = opts.env ?? process.env
  const path = installConfigPath(env, opts.home)
  const gate = inspectConfigFile(path, opts.statSync ?? fsStatSync)
  if (gate.kind === 'absent') return { kind: 'absent', path }
  if (gate.kind === 'error') return { kind: 'invalid', path, problems: [gate.problem] }

  const read = readConfigText(path, opts.readFileSync ?? defaultReadFileSync)
  if (read.kind === 'absent') return { kind: 'absent', path }
  if (read.kind === 'error') return { kind: 'invalid', path, problems: [read.problem] }

  // Belt and braces: a file can grow between the stat and the read, and the
  // bound exists to cap what is parsed, not what was measured.
  const size = Buffer.byteLength(read.text, 'utf8')
  if (size > MAX_CONFIG_BYTES) {
    return { kind: 'invalid', path, problems: [oversizeProblem(size)] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch (error: unknown) {
    return { kind: 'invalid', path, problems: [`(root): not valid JSON: ${describeJsonFault(error)}`] }
  }

  const validated = installConfigSchema.safeParse(parsed)
  if (!validated.success) {
    return { kind: 'invalid', path, problems: formatInstallConfigErrors(validated.error) }
  }
  return { kind: 'ok', path, config: validated.data }
}

/** `(root): ...` — the path is named by the caller, so the line names the fault only. */
function oversizeProblem(size: number): string {
  return `(root): config is ${size} bytes, larger than the ${MAX_CONFIG_BYTES}-byte bound`
}

type FileGate =
  | { readonly kind: 'ok' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'error'; readonly problem: string }

/**
 * What the config path IS, before anything opens it: a regular file within the
 * byte bound, a missing file, or a fault. Anything else — a directory, a
 * device, and above all a FIFO — is refused here rather than read, because a
 * read of a FIFO nobody writes to never returns and this runs at import time.
 */
function inspectConfigFile(path: string, statSync: (path: string) => ConfigFileStat): FileGate {
  let stats: ConfigFileStat
  try {
    stats = statSync(path)
  } catch (error: unknown) {
    return describeReadFault(error)
  }
  if (!stats.isFile()) return { kind: 'error', problem: '(root): not a regular file' }
  if (stats.size > MAX_CONFIG_BYTES) {
    return { kind: 'error', problem: oversizeProblem(stats.size) }
  }
  return { kind: 'ok' }
}

type TextRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'error'; readonly problem: string }

/**
 * A file that is not there — and a path whose parent is not a directory, which
 * is the same statement made one component earlier — means "no config", the
 * shape `readFileIfExists` (`src/vault/files.ts`) established. Every other
 * errno is a fault worth refusing on: an EACCES config is a config the
 * operator meant to apply and this process cannot see.
 */
function readConfigText(path: string, readFileSync: (path: string) => string): TextRead {
  try {
    return { kind: 'text', text: readFileSync(path) }
  } catch (error: unknown) {
    const fault = describeReadFault(error)
    return fault.kind === 'absent' ? { kind: 'absent' } : fault
  }
}

/** Classifies a `stat`/`read` failure: "no config here" or a fault worth refusing on. */
function describeReadFault(error: unknown): Extract<FileGate, { kind: 'absent' | 'error' }> {
  const code = errnoCodeOf(error)
  if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' }
  const message = error instanceof Error ? error.message : String(error)
  return { kind: 'error', problem: code === undefined ? message : `${code}: ${message}` }
}

/** Line/column of a `JSON.parse` failure, when V8's message carries one. */
const JSON_POSITION_PATTERN = /\(line (\d+) column (\d+)\)/

/**
 * V8 embeds a snippet of the offending input in most `SyntaxError` messages,
 * and this plane never echoes file contents into an error — `describeCause`
 * in `src/policy/store-backend.ts` made that rule for the same reason. The
 * position is the useful half and carries nothing from the file, so it is the
 * only half repeated; a message without one degrades to the bare fact.
 */
function describeJsonFault(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const position = JSON_POSITION_PATTERN.exec(message)
  return position === null
    ? 'the file does not parse as JSON'
    : `parse error at line ${position[1]} column ${position[2]}`
}

function defaultReadFileSync(path: string): string {
  return fsReadFileSync(path, 'utf8')
}
