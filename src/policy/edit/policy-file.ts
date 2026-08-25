import { randomBytes } from 'node:crypto'
import {
  open as fsOpen,
  readFile as fsReadFile,
  rename as fsRename,
  rm as fsRm,
  stat as fsStat,
  writeFile as fsWriteFile,
} from 'node:fs/promises'
import { dirname } from 'node:path'
import { formatPolicyErrors, loadPolicy } from '../load.js'
import { policyHashOf } from '../provenance.js'
import { parsePolicy, type Policy } from '../schema.js'

/**
 * The one write path for `policy.json` (plan policy-tool-rules-ui §2).
 *
 * Reading for edit tells `absent` from `loaded` from `error` — the UI needs
 * all three (O4: no policy means enforcement is off and the controls are
 * disabled; O3: a broken file on disk is a banner, never a write target) —
 * and hands back the RAW parsed document beside the effective policy, so a
 * caller does read → `applyToolRuleToDocument` → write and the file stays
 * the operator's (no defaults spelled out, no keys reordered).
 *
 * Writing is compare-and-swap on `policyHashOf`: the caller says which
 * effective policy it edited (`expectedHash`, `null` for "I expect no file"),
 * and a file that has since moved on — by hand, by another admin, by the
 * CLI — yields `conflict` with what is there now instead of a lost update.
 *
 * What makes the compare-and-swap hold, and where it stops holding:
 *
 *  - Across PROCESSES (`ui` and `policy set` at once) the whole
 *    read → compare → validate → write → rename section runs under a sidecar
 *    lock, `<path>.lock`, created with `O_EXCL`. Exclusive create is atomic
 *    on every local filesystem and on SMB; the loser never waits — a UI
 *    request must not block — it re-reads the file and answers `conflict`
 *    with the hash that is there now. A lock older than
 *    `POLICY_LOCK_STALE_MS` is a crashed writer's leftover and is broken.
 *    On NFS, `O_EXCL` is only reliable with NFSv3+ and a cooperating server,
 *    and clock skew between clients makes the staleness check approximate:
 *    a shared journal directory on NFS is outside what this module promises.
 *  - Inside ONE process writes to the same path are additionally chained,
 *    so two handlers racing on the same token resolve deterministically as
 *    one `written` and one `conflict` without touching the lock twice.
 *
 * The file itself is replaced atomically: unique temp in the same directory
 * (so `rename` is a same-filesystem move), then `rename`. A reader — a live
 * `connect` re-checking the file — sees the old bytes or the new, never a
 * half-written document.
 */

/** Size and modification time of a file, as this module needs them. */
export interface PolicyFileStat {
  readonly mtimeMs: number
}

/** Every filesystem touch of this module, injectable for tests. */
export interface PolicyFileDeps {
  readonly readFile: (path: string) => Promise<string>
  readonly writeFile: (path: string, content: string) => Promise<void>
  readonly rename: (from: string, to: string) => Promise<void>
  /** Removes a file; a missing file is not an error. */
  readonly remove: (path: string) => Promise<void>
  /** Creates an empty file, failing with `EEXIST` if it already exists (`O_EXCL`). */
  readonly openExclusive: (path: string) => Promise<void>
  /** File metadata, or `null` when the file does not exist. */
  readonly stat: (path: string) => Promise<PolicyFileStat | null>
}

/**
 * Age past which a `<path>.lock` is treated as left behind by a writer that
 * died mid-section rather than one still working. A write is a few
 * milliseconds of filesystem work; ten seconds leaves a wide margin for a
 * stalled disk while keeping an operator from being locked out for long
 * after a crash.
 */
export const POLICY_LOCK_STALE_MS = 10_000

/** Owner read/write only: the policy is a security boundary, like the vault and the journal directory. */
const POLICY_FILE_MODE = 0o600
const TEMP_SUFFIX = '.tmp'
const LOCK_SUFFIX = '.lock'
const STALE_SUFFIX = '.stale'
const UNIQUE_RANDOM_BYTES = 6
/** Indentation of the written document; the file stays hand-editable. */
const JSON_INDENT = 2
const EEXIST = 'EEXIST'
const ENOENT = 'ENOENT'

export const defaultPolicyFileDeps: PolicyFileDeps = {
  readFile: (path) => fsReadFile(path, 'utf8'),
  writeFile: (path, content) => fsWriteFile(path, content, { encoding: 'utf8', mode: POLICY_FILE_MODE }),
  rename: (from, to) => fsRename(from, to),
  remove: (path) => fsRm(path, { force: true }),
  openExclusive: async (path) => {
    const handle = await fsOpen(path, 'wx', POLICY_FILE_MODE)
    await handle.close()
  },
  stat: async (path) => {
    try {
      return { mtimeMs: (await fsStat(path)).mtimeMs }
    } catch (error: unknown) {
      if (hasCode(error, ENOENT)) return null
      throw error
    }
  },
}

export type PolicyFileReadResult =
  | {
      readonly status: 'loaded'
      /** The effective (defaulted) policy — what the gate runs and what `hash` fingerprints. */
      readonly policy: Policy
      readonly hash: string
      /** The file's text as read. */
      readonly raw: string
      /** The file's JSON as parsed, untouched by the schema: the input of `applyToolRuleToDocument`. */
      readonly document: unknown
    }
  | { readonly status: 'absent' }
  | { readonly status: 'error'; readonly errors: readonly string[] }

export interface WritePolicyFileOptions {
  /** `policyHashOf` of the policy the caller edited; `null` means "I expect no file to exist". */
  readonly expectedHash: string | null
}

export type PolicyFileWriteResult =
  | { readonly status: 'written'; readonly hashBefore: string | null; readonly hashAfter: string }
  | { readonly status: 'conflict'; readonly currentHash: string | null }
  | { readonly status: 'error'; readonly errors: readonly string[] }

/** A writer with its own in-process chain; one per process is the norm, one per "process" in tests. */
export interface PolicyFileWriter {
  readonly write: (
    path: string,
    document: unknown,
    options: WritePolicyFileOptions,
    deps?: PolicyFileDeps,
  ) => Promise<PolicyFileWriteResult>
}

/**
 * Reads `path` as a policy file. The bytes are read here (so ENOENT can be
 * told apart), and parsing plus error wording is delegated to `loadPolicy`
 * with the text already in hand — one JSON/schema error format for the
 * proxy startup, the CLI and the UI.
 */
export async function readPolicyFileForEdit(
  path: string,
  deps: PolicyFileDeps = defaultPolicyFileDeps,
): Promise<PolicyFileReadResult> {
  const read = await readText(path, deps)
  if (read.status !== 'found') return read

  const loaded = await loadPolicy({ explicitPath: path, cwd: dirname(path), readFile: async () => read.text })
  if (loaded.status === 'error') return { status: 'error', errors: loaded.errors }
  if (loaded.status === 'disabled') {
    return { status: 'error', errors: [`policy loader reported no source for explicit path "${path}"`] }
  }
  // Valid per the loader, so this second parse cannot fail; it is the raw
  // document the loader validated but does not hand back.
  const document: unknown = JSON.parse(read.text)
  return { status: 'loaded', policy: loaded.policy, hash: policyHashOf(loaded.policy), raw: read.text, document }
}

/**
 * Creates an independent writer: its own per-path chain, nothing else. The
 * module's `writePolicyFile` uses one shared writer; tests create two to
 * stand in for two processes, leaving only the lock file between them.
 */
export function createPolicyFileWriter(): PolicyFileWriter {
  const chains = new Map<string, Promise<void>>()
  return {
    write: (path, document, options, deps = defaultPolicyFileDeps) =>
      serializedByPath(chains, path, () => writeLocked(path, document, options.expectedHash, deps)),
  }
}

const defaultWriter = createPolicyFileWriter()

/**
 * Compare-and-swap write of the raw `document` (the operator's JSON with the
 * edit applied — see `applyToolRuleToDocument`) to `path`. Never throws:
 * every failure shape is a result, and a failed write never leaves a temp
 * or lock file behind or touches the original.
 */
export function writePolicyFile(
  path: string,
  document: unknown,
  options: WritePolicyFileOptions,
  deps: PolicyFileDeps = defaultPolicyFileDeps,
): Promise<PolicyFileWriteResult> {
  return defaultWriter.write(path, document, options, deps)
}

/** The cross-process critical section: lock, do the CAS write, always unlock. */
async function writeLocked(
  path: string,
  document: unknown,
  expectedHash: string | null,
  deps: PolicyFileDeps,
): Promise<PolicyFileWriteResult> {
  const lockPath = `${path}${LOCK_SUFFIX}`
  const acquired = await acquireLock(lockPath, deps).catch(
    (error: unknown): PolicyFileWriteResult => ({
      status: 'error',
      errors: [`cannot lock policy file "${path}": ${describeCause(error)}`],
    }),
  )
  if (acquired !== true) return acquired === false ? lockedByOther(path, deps) : acquired
  try {
    return await writeUnderLock(path, document, expectedHash, deps)
  } finally {
    await deps.remove(lockPath).catch(() => undefined)
  }
}

/**
 * `true` when the lock is ours, `false` when another live writer holds it.
 * A stale lock is broken by RENAMING it away rather than removing it: two
 * writers that both judge it stale can both remove-and-create, but only one
 * rename of the same entry succeeds, so only one of them can go on to hold
 * a fresh lock. Any failure other than "already exists" propagates.
 */
async function acquireLock(lockPath: string, deps: PolicyFileDeps): Promise<boolean> {
  if (await tryCreateLock(lockPath, deps)) return true
  const info = await deps.stat(lockPath)
  if (info !== null && Date.now() - info.mtimeMs < POLICY_LOCK_STALE_MS) return false
  if (info !== null) await breakStaleLock(lockPath, deps)
  return tryCreateLock(lockPath, deps)
}

async function tryCreateLock(lockPath: string, deps: PolicyFileDeps): Promise<boolean> {
  try {
    await deps.openExclusive(lockPath)
    return true
  } catch (error: unknown) {
    if (hasCode(error, EEXIST)) return false
    throw error
  }
}

async function breakStaleLock(lockPath: string, deps: PolicyFileDeps): Promise<void> {
  const parkedPath = `${lockPath}.${uniqueSuffix()}${STALE_SUFFIX}`
  try {
    await deps.rename(lockPath, parkedPath)
  } catch (error: unknown) {
    // Someone else broke it first; the retry of the exclusive create decides.
    if (hasCode(error, ENOENT)) return
    throw error
  }
  await deps.remove(parkedPath).catch(() => undefined)
}

/** The answer to a live foreign lock: no waiting, just what is on disk right now. */
async function lockedByOther(path: string, deps: PolicyFileDeps): Promise<PolicyFileWriteResult> {
  const current = await readPolicyFileForEdit(path, deps)
  if (current.status === 'error') return current
  return { status: 'conflict', currentHash: current.status === 'loaded' ? current.hash : null }
}

async function writeUnderLock(
  path: string,
  document: unknown,
  expectedHash: string | null,
  deps: PolicyFileDeps,
): Promise<PolicyFileWriteResult> {
  const current = await readPolicyFileForEdit(path, deps)
  if (current.status === 'error') return current
  const currentHash = current.status === 'loaded' ? current.hash : null
  if (currentHash !== expectedHash) return { status: 'conflict', currentHash }

  // What cannot be loaded cannot be written: the document goes through the
  // schema before it becomes the file every proxy reads. The DOCUMENT is what
  // is serialized — the parsed policy only supplies the fingerprint.
  const parsed = parsePolicy(document)
  if (!parsed.ok) return { status: 'error', errors: formatPolicyErrors(parsed.error) }

  const content = `${JSON.stringify(document, null, JSON_INDENT)}\n`
  const failure = await replaceAtomically(path, content, deps)
  if (failure !== undefined) return { status: 'error', errors: [failure] }
  return { status: 'written', hashBefore: currentHash, hashAfter: policyHashOf(parsed.policy) }
}

type TextRead =
  | { readonly status: 'found'; readonly text: string }
  | { readonly status: 'absent' }
  | { readonly status: 'error'; readonly errors: readonly string[] }

async function readText(path: string, deps: PolicyFileDeps): Promise<TextRead> {
  try {
    return { status: 'found', text: await deps.readFile(path) }
  } catch (error: unknown) {
    if (hasCode(error, ENOENT)) return { status: 'absent' }
    return { status: 'error', errors: [`cannot read policy file "${path}": ${describeCause(error)}`] }
  }
}

/** Temp-then-rename replace; returns the failure message instead of throwing, after removing the temp. */
async function replaceAtomically(path: string, content: string, deps: PolicyFileDeps): Promise<string | undefined> {
  const tempPath = `${path}.${uniqueSuffix()}${TEMP_SUFFIX}`
  try {
    await deps.writeFile(tempPath, content)
    await deps.rename(tempPath, path)
    return undefined
  } catch (error: unknown) {
    await deps.remove(tempPath).catch(() => undefined)
    return `cannot write policy file "${path}": ${describeCause(error)}`
  }
}

/** One chain of writes per path; an entry lives only while a write is in flight. */
async function serializedByPath<T>(chains: Map<string, Promise<void>>, path: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(path) ?? Promise.resolve()
  const run = previous.then(task)
  const tail = run.then(() => undefined, () => undefined)
  chains.set(path, tail)
  try {
    return await run
  } finally {
    if (chains.get(path) === tail) chains.delete(path)
  }
}

function uniqueSuffix(): string {
  return `${process.pid}.${randomBytes(UNIQUE_RANDOM_BYTES).toString('hex')}`
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
