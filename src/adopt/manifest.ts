import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { errnoCodeOf } from '../errno.js'
import { writeOwnerOnlyFile } from './files.js'

/**
 * The record `adopt --apply` leaves for `adopt --undo`: which entry of which
 * file it changed, from what command line to what. Command lines only —
 * `env` is where configs keep API keys, and adopt never changes it. Read back
 * through a schema: it is a file on disk, not trusted input.
 */

export const ADOPT_DIR_NAME = 'adopt'
export const MANIFEST_FILE_NAME = 'manifest.json'
const MANIFEST_VERSION = 1
const JSON_INDENT = 2

const commandLineSchema = z.object({ command: z.string(), args: z.array(z.string()).optional() })

const changeSchema = z.object({
  file: z.string(),
  path: z.array(z.string()),
  name: z.string(),
  client: z.enum(['claude-code', 'cursor', 'claude-desktop']),
  scope: z.string(),
  before: commandLineSchema,
  after: commandLineSchema,
})

const manifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  createdAt: z.string(),
  changes: z.array(changeSchema),
  undoneAt: z.string().optional(),
})

export type ManifestChange = z.infer<typeof changeSchema>
export type AdoptManifest = z.infer<typeof manifestSchema>

export function manifestOf(createdAt: Date, changes: readonly ManifestChange[]): AdoptManifest {
  return { version: MANIFEST_VERSION, createdAt: createdAt.toISOString(), changes: [...changes] }
}

export async function writeManifest(dir: string, manifest: AdoptManifest): Promise<void> {
  await writeOwnerOnlyFile(join(dir, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, JSON_INDENT)}\n`)
}

export type LatestManifest =
  | { readonly kind: 'nothing' }
  | { readonly kind: 'found'; readonly dir: string; readonly manifest: AdoptManifest }
  | { readonly kind: 'problem'; readonly dir: string; readonly reason: string }

async function readManifest(dir: string): Promise<LatestManifest | undefined> {
  let text: string
  try {
    text = await readFile(join(dir, MANIFEST_FILE_NAME), 'utf8')
  } catch (error) {
    // A run whose every write failed leaves copies but no manifest: nothing of it to undo.
    if (errnoCodeOf(error) === 'ENOENT') return undefined
    return { kind: 'problem', dir, reason: `could not read ${MANIFEST_FILE_NAME} (${errnoCodeOf(error) ?? String(error)})` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { kind: 'problem', dir, reason: `${MANIFEST_FILE_NAME} is not valid JSON` }
  }
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) return { kind: 'problem', dir, reason: `${MANIFEST_FILE_NAME} is not one adopt wrote` }
  return parsed.data.undoneAt === undefined ? { kind: 'found', dir, manifest: parsed.data } : undefined
}

/** The newest run not undone yet. Run folders are ISO timestamps, so name order is time order. */
export async function latestActiveManifest(dataDir: string): Promise<LatestManifest> {
  const adoptDir = join(dataDir, ADOPT_DIR_NAME)
  let names: string[]
  try {
    names = await readdir(adoptDir)
  } catch (error) {
    if (errnoCodeOf(error) === 'ENOENT') return { kind: 'nothing' }
    throw error
  }
  for (const name of [...names].sort().reverse()) {
    const latest = await readManifest(join(adoptDir, name))
    if (latest !== undefined) return latest
  }
  return { kind: 'nothing' }
}
