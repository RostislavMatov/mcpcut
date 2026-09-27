import { readFileSync as fsReadFileSync, statSync as fsStatSync } from 'node:fs'

/**
 * A secret read from a file named by an env var (plan `hub-signin-accounts`
 * H4; plan `tenant-orchestrator` Tasks 4–5): the GitHub client secret, the
 * provisioner's Bearer token on both of its ends. A secret is never accepted
 * in the environment itself — a process's env is visible to `/proc`, crash
 * reporters and child processes far more readily than a 0600 file is — so the
 * file is its only copy at rest and must not be group- or world-readable.
 *
 * Never throws: a problem comes back as one line naming the env var, for the
 * config loader to list beside every other problem.
 */

/** Minimal `fs.Stats` surface the permission check needs; real `statSync` satisfies it. */
export interface SecretFileStat {
  isFile(): boolean
  readonly mode: number
}

export interface SecretFileSeams {
  /** Defaults to `node:fs`'s `statSync`. */
  readonly statSecretFile?: (path: string) => SecretFileStat
  /** Defaults to `node:fs`'s `readFileSync` as UTF-8. */
  readonly readSecretFile?: (path: string) => string
}

export type SecretFileRead = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly problem: string }

/** Bits allowed on a secret file: owner read/write, nothing else (0600 and 0400 both pass). */
const SECRET_FILE_ALLOWED_MODE_BITS = 0o600

/**
 * Reads the secret in `path` for `varName`, refusing a file that does not
 * exist, is not a regular file, grants any bit beyond owner read/write, or
 * holds nothing but whitespace. Surrounding whitespace is trimmed.
 */
export function readSecretFile(varName: string, path: string, seams: SecretFileSeams = {}): SecretFileRead {
  const statSync = seams.statSecretFile ?? fsStatSync
  const readFileSync = seams.readSecretFile ?? ((p: string) => fsReadFileSync(p, 'utf8'))
  const refuse = (why: string): SecretFileRead => ({ ok: false, problem: `${varName}: ${why}` })

  let stats: SecretFileStat
  try {
    stats = statSync(path)
  } catch (error: unknown) {
    return refuse(`could not stat "${path}": ${describeError(error)}`)
  }
  if (!stats.isFile()) return refuse(`"${path}" is not a regular file`)
  const excessBits = (stats.mode & 0o777) & ~SECRET_FILE_ALLOWED_MODE_BITS
  if (excessBits !== 0) {
    const mode = (stats.mode & 0o777).toString(8).padStart(3, '0')
    return refuse(`"${path}" has mode 0${mode}, wider than the required 0600 (owner read/write only)`)
  }

  let text: string
  try {
    text = readFileSync(path)
  } catch (error: unknown) {
    return refuse(`could not read "${path}": ${describeError(error)}`)
  }
  const value = text.trim()
  if (value.length === 0) return refuse(`"${path}" is empty`)
  return { ok: true, value }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A shared Bearer secret: visible ASCII (it goes into a header), long enough not to be guessed. */
export const MIN_BEARER_TOKEN_LENGTH = 32
const BEARER_TOKEN_PATTERN = /^[\x21-\x7e]+$/
const MAX_BEARER_TOKEN_LENGTH = 1024

/**
 * `readSecretFile`, plus the rule for a Bearer secret shared by two
 * processes (the hub and the provisioner): at least 32 visible ASCII
 * characters — `openssl rand -hex 32` makes one.
 */
export function readBearerTokenFile(varName: string, path: string, seams: SecretFileSeams = {}): SecretFileRead {
  const read = readSecretFile(varName, path, seams)
  if (!read.ok) return read
  const { value } = read
  if (value.length < MIN_BEARER_TOKEN_LENGTH || value.length > MAX_BEARER_TOKEN_LENGTH || !BEARER_TOKEN_PATTERN.test(value)) {
    return {
      ok: false,
      problem:
        `${varName}: "${path}" must hold ${MIN_BEARER_TOKEN_LENGTH}–${MAX_BEARER_TOKEN_LENGTH} visible ASCII characters ` +
        '(e.g. `openssl rand -hex 32`)',
    }
  }
  return read
}
