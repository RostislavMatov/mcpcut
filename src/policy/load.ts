import { readFile as fsReadFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { z } from 'zod'
import { JOURNAL_DIR } from '../config.js'
import { POLICY_ENV_VAR, POLICY_FILE_NAME } from './constants.js'
import { type Policy, parsePolicy } from './schema.js'

/**
 * Resolves and loads `policy.json`. Four possible sources, checked in order,
 * **first found wins -- no merging**: merging security config from multiple
 * sources is a classic footgun ("where did this allow come from?"), see the
 * M2 plan's "Принятые решения" table.
 *
 *   1. `opts.explicitPath` (`--policy <path>` on the CLI)
 *   2. `$MCP_JOURNAL_POLICY` (`opts.env[POLICY_ENV_VAR]`)
 *   3. `<opts.cwd>/.mcp-journal/policy.json` (project-level)
 *   4. `<opts.journalDir>/policy.json` (home-level, defaults to `JOURNAL_DIR`)
 *
 * A source the operator named explicitly (1 or 2) must exist: a missing file
 * there is a hard error, because the operator asked for that exact file. A
 * missing file at the default locations (3 or 4) is not an error -- loading
 * just keeps looking, and falls back to `{ status: 'disabled' }` (mode A,
 * journal-only, see M2 plan) when none of the four locations has a file.
 *
 * Never throws for any of the "expected" failure shapes (missing file,
 * unreadable file, broken JSON, schema violation) and never calls
 * `process.exit` -- callers (CLI, proxy startup) decide how a `status:
 * 'error'` result is surfaced and whether the process should exit.
 */

export interface LoadPolicyOptions {
  /** Explicit path from a CLI flag. Takes priority over every other source. */
  readonly explicitPath?: string
  /** Environment to read `POLICY_ENV_VAR` from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Base directory for the project-level source. Defaults to `process.cwd()`. */
  readonly cwd?: string
  /** Base directory for the home-level source. Defaults to `JOURNAL_DIR`. */
  readonly journalDir?: string
  /** Reads a file as UTF-8 text. Defaults to `node:fs/promises` `readFile`. Injectable for tests. */
  readonly readFile?: (path: string) => Promise<string>
}

/** Discriminated result of resolving and loading a policy file. Never throws. */
export type PolicyLoadResult =
  | { readonly status: 'loaded'; readonly policy: Policy; readonly sourcePath: string }
  | { readonly status: 'disabled' }
  | { readonly status: 'error'; readonly sourcePath: string; readonly errors: readonly string[] }

/** Subdirectory name for the project-level source, relative to `opts.cwd`. */
const PROJECT_POLICY_SUBDIR = '.mcp-journal'

/** One resolved candidate path to try reading, in resolution order. */
interface PolicyCandidate {
  readonly path: string
  /** `true` for sources the operator named explicitly: a missing file there is an error, not a fallthrough. */
  readonly required: boolean
}

export async function loadPolicy(opts: LoadPolicyOptions = {}): Promise<PolicyLoadResult> {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const journalDir = opts.journalDir ?? JOURNAL_DIR
  const readFile = opts.readFile ?? defaultReadFile

  const resolution = resolveCandidates({ explicitPath: opts.explicitPath, env, cwd, journalDir })
  if ('error' in resolution) {
    return resolution.error
  }

  for (const candidate of resolution.candidates) {
    const attempt = await readSource(candidate.path, readFile)

    if (attempt.status === 'not-found') {
      if (candidate.required) {
        return {
          status: 'error',
          sourcePath: candidate.path,
          errors: [`policy file not found: ${candidate.path}`],
        }
      }
      continue
    }

    if (attempt.status === 'read-error') {
      return { status: 'error', sourcePath: candidate.path, errors: [attempt.message] }
    }

    return parseSource(candidate.path, attempt.text)
  }

  return { status: 'disabled' }
}

/**
 * Renders a `z.ZodError` as one human-readable line per issue: `path.to.field:
 * message`, or `(root): message` for an issue with no path. zod v4 reports a
 * `strictObject`'s extra keys as a single `unrecognized_keys` issue carrying
 * a `keys` array on the *container's* path rather than one issue per key, so
 * that case is expanded into one `path: unknown key "x"` line per key --
 * otherwise a typo like `"tols"` next to three other typos would collapse
 * into one vague line instead of pointing at each bad key.
 */
export function formatPolicyErrors(error: z.ZodError): string[] {
  return error.issues.flatMap((issue) => {
    const path = formatIssuePath(issue.path)
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => `${path}: unknown key "${key}"`)
    }
    return [`${path}: ${issue.message}`]
  })
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  return path.length > 0 ? path.join('.') : '(root)'
}

function defaultReadFile(path: string): Promise<string> {
  return fsReadFile(path, 'utf8')
}

type CandidateResolution =
  | { readonly candidates: readonly PolicyCandidate[] }
  | { readonly error: PolicyLoadResult }

function resolveCandidates(args: {
  readonly explicitPath: string | undefined
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  readonly journalDir: string
}): CandidateResolution {
  const { explicitPath, env, cwd, journalDir } = args

  if (explicitPath !== undefined) {
    return { candidates: [{ path: resolveAbsolute(cwd, explicitPath), required: true }] }
  }

  const envValue = env[POLICY_ENV_VAR]
  if (envValue !== undefined) {
    const envError = validateEnvPath(envValue)
    if (envError !== undefined) {
      return { error: envError }
    }
    return { candidates: [{ path: resolveAbsolute(cwd, envValue), required: true }] }
  }

  return {
    candidates: [
      {
        path: resolveAbsolute(cwd, join(PROJECT_POLICY_SUBDIR, POLICY_FILE_NAME)),
        required: false,
      },
      { path: resolveAbsolute(cwd, join(journalDir, POLICY_FILE_NAME)), required: false },
    ],
  }
}

/**
 * `MCP_JOURNAL_POLICY` is operator-controlled, not attacker-controlled, so
 * full sandboxing is out of scope (see M2 plan). It must still not be able
 * to crash the proxy: a null byte reaches `fs` as `ERR_INVALID_ARG_VALUE`,
 * and an empty value would otherwise silently resolve to `opts.cwd` itself
 * (a directory, not a policy file) instead of reporting the misconfiguration.
 */
function validateEnvPath(value: string): PolicyLoadResult | undefined {
  if (value.length === 0) {
    return { status: 'error', sourcePath: value, errors: [`${POLICY_ENV_VAR} is set but empty`] }
  }
  if (value.includes('\0')) {
    return {
      status: 'error',
      sourcePath: value,
      errors: [`${POLICY_ENV_VAR} contains a null byte, which is not a valid path`],
    }
  }
  return undefined
}

/**
 * Path traversal guard: every candidate this module reads from is resolved
 * through `path.resolve`, which is always absolute by construction. The
 * `isAbsolute` check below documents and enforces that invariant rather than
 * trusting it silently.
 */
function resolveAbsolute(cwd: string, value: string): string {
  const resolved = resolve(cwd, value)
  if (!isAbsolute(resolved)) {
    throw new Error(`resolved policy path is not absolute: ${resolved}`)
  }
  return resolved
}

type SourceReadAttempt =
  | { readonly status: 'found'; readonly text: string }
  | { readonly status: 'not-found' }
  | { readonly status: 'read-error'; readonly message: string }

async function readSource(
  path: string,
  readFile: (path: string) => Promise<string>,
): Promise<SourceReadAttempt> {
  try {
    const text = await readFile(path)
    return { status: 'found', text }
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return { status: 'not-found' }
    }
    return { status: 'read-error', message: `cannot read policy file "${path}": ${describeCause(error)}` }
  }
}

function parseSource(path: string, text: string): PolicyLoadResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error: unknown) {
    return {
      status: 'error',
      sourcePath: path,
      errors: [`invalid JSON in "${path}": ${describeCause(error)}`],
    }
  }

  const result = parsePolicy(raw)
  if (!result.ok) {
    return { status: 'error', sourcePath: path, errors: formatPolicyErrors(result.error) }
  }
  return { status: 'loaded', policy: result.policy, sourcePath: path }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
