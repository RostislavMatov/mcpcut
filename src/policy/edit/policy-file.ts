import { randomBytes } from 'node:crypto'
import { readFile as fsReadFile, rename as fsRename, rm as fsRm, writeFile as fsWriteFile } from 'node:fs/promises'
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
 * Writing is compare-and-swap on `policyHashOf`: the caller says which
 * effective policy it edited (`expectedHash`, `null` for "I expect no file"),
 * and a file that has since moved on — by hand, by another admin, by the
 * CLI — yields `conflict` with what is there now instead of a lost update.
 *
 * Between processes the CAS is the only guard; inside one process writes to
 * the same path are additionally serialized through a promise chain, so two
 * handlers racing on the same token resolve as exactly one `written` and one
 * `conflict` rather than a torn file.
 *
 * The file itself is replaced atomically: unique temp in the same directory
 * (so `rename` is a same-filesystem move), then `rename`. A reader — a live
 * `connect` re-checking the file — sees the old bytes or the new, never a
 * half-written document.
 */

/** Every filesystem touch of this module, injectable for tests. */
export interface PolicyFileDeps {
  readonly readFile: (path: string) => Promise<string>
  readonly writeFile: (path: string, content: string) => Promise<void>
  readonly rename: (from: string, to: string) => Promise<void>
  readonly remove: (path: string) => Promise<void>
}

/** Owner read/write only: the policy is a security boundary, like the vault and the journal directory. */
const POLICY_FILE_MODE = 0o600
const TEMP_SUFFIX = '.tmp'
const TEMP_RANDOM_BYTES = 6
/** Indentation of the written document; the file stays hand-editable. */
const JSON_INDENT = 2

export const defaultPolicyFileDeps: PolicyFileDeps = {
  readFile: (path) => fsReadFile(path, 'utf8'),
  writeFile: (path, content) => fsWriteFile(path, content, { encoding: 'utf8', mode: POLICY_FILE_MODE }),
  rename: (from, to) => fsRename(from, to),
  remove: (path) => fsRm(path, { force: true }),
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
 * Compare-and-swap write of the raw `document` (the operator's JSON with the
 * edit applied — see `applyToolRuleToDocument`) to `path`. Never throws:
 * every failure shape is a result, and a failed write never leaves a temp
 * file behind or touches the original.
 */
export function writePolicyFile(
  path: string,
  document: unknown,
  options: WritePolicyFileOptions,
  deps: PolicyFileDeps = defaultPolicyFileDeps,
): Promise<PolicyFileWriteResult> {
  return serializedByPath(path, () => writeUnderLock(path, document, options.expectedHash, deps))
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
    if (isEnoent(error)) return { status: 'absent' }
    return { status: 'error', errors: [`cannot read policy file "${path}": ${describeCause(error)}`] }
  }
}

/** Temp-then-rename replace; returns the failure message instead of throwing, after removing the temp. */
async function replaceAtomically(path: string, content: string, deps: PolicyFileDeps): Promise<string | undefined> {
  const tempPath = `${path}.${process.pid}.${randomBytes(TEMP_RANDOM_BYTES).toString('hex')}${TEMP_SUFFIX}`
  try {
    await deps.writeFile(tempPath, content)
    await deps.rename(tempPath, path)
    return undefined
  } catch (error: unknown) {
    await deps.remove(tempPath).catch(() => undefined)
    return `cannot write policy file "${path}": ${describeCause(error)}`
  }
}

/**
 * The in-process serialization point: one chain of writes per path. The map
 * is the single piece of module state here, and an entry lives only while a
 * write is in flight.
 */
const writeChains = new Map<string, Promise<void>>()

async function serializedByPath<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(path) ?? Promise.resolve()
  const run = previous.then(task)
  const tail = run.then(() => undefined, () => undefined)
  writeChains.set(path, tail)
  try {
    return await run
  } finally {
    if (writeChains.get(path) === tail) writeChains.delete(path)
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
