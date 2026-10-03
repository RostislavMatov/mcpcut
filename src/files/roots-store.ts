import { join } from 'node:path'
import { z } from 'zod'
import { JOURNAL_DIR } from '../config.js'
import { createJsonStore, type JsonStore } from '../policy/store.js'
import { MAX_ROOTS, ROOTS_FILE_NAME } from './constants.js'
import { absolutePathSchema } from './rule-schema.js'

/**
 * The folders the file module may work with (ADR-0020 §2): declared by an
 * admin, stored as the `files-roots.json` document in `<journalDir>/state.db`
 * through `createJsonStore` — transactional, 0600/0700, like agents and the
 * registry. Paths are stored canonical (see `roots-admin.ts`); every update
 * returns a new document.
 */

const rootEntrySchema = z.strictObject({ path: absolutePathSchema, addedAt: z.iso.datetime() })

export const rootsFileSchema = z.strictObject({
  version: z.literal(1),
  roots: z
    .array(rootEntrySchema)
    .max(MAX_ROOTS)
    .refine((roots) => new Set(roots.map((root) => root.path)).size === roots.length, 'root paths must be unique'),
})

export type RootsFile = z.infer<typeof rootsFileSchema>
export type RootEntry = RootsFile['roots'][number]

export function parseRootsFile(raw: unknown): { ok: true; file: RootsFile } | { ok: false; error: z.ZodError } {
  const result = rootsFileSchema.safeParse(raw)
  return result.success ? { ok: true, file: result.data } : { ok: false, error: result.error }
}

/** Raised by `add` when the list already holds `MAX_ROOTS` roots. */
export class RootsLimitError extends Error {
  constructor() {
    super(`at most ${MAX_ROOTS} roots: remove one first with \`mcpcut files root remove <path>\``)
    this.name = 'RootsLimitError'
  }
}

export interface RootsStore {
  /** All roots, sorted by path. */
  list(): Promise<readonly RootEntry[]>
  /** Adds a root; `added: false` when the path is already declared. */
  add(path: string): Promise<{ readonly added: boolean }>
  /** Removes a root; `removed: false` when it was not declared. */
  remove(path: string): Promise<{ readonly removed: boolean }>
}

export interface RootsStoreOptions {
  readonly journalDir?: string
  readonly clock?: () => Date
}

const EMPTY_FILE: RootsFile = { version: 1, roots: [] }

function validateRoots(raw: unknown): RootsFile {
  const result = rootsFileSchema.safeParse(raw)
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
    throw new Error(`roots file failed validation: ${details.join('; ')}`)
  }
  return result.data
}

function byPath(left: RootEntry, right: RootEntry): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}

export function createRootsStore(opts: RootsStoreOptions = {}): RootsStore {
  const clock = opts.clock ?? (() => new Date())
  const store: JsonStore<RootsFile> = createJsonStore(join(opts.journalDir ?? JOURNAL_DIR, ROOTS_FILE_NAME), {
    validate: validateRoots,
    defaultValue: EMPTY_FILE,
  })

  async function list(): Promise<readonly RootEntry[]> {
    return [...(await store.read()).roots].sort(byPath)
  }

  async function add(path: string): Promise<{ readonly added: boolean }> {
    const entry: RootEntry = { path, addedAt: clock().toISOString() }
    // Reset per attempt: `update` may re-run the callback.
    let added = false
    await store.update((current) => {
      added = false
      if (current.roots.some((root) => root.path === path)) return current
      if (current.roots.length >= MAX_ROOTS) throw new RootsLimitError()
      added = true
      return { ...current, roots: [...current.roots, entry].sort(byPath) }
    })
    return { added }
  }

  async function remove(path: string): Promise<{ readonly removed: boolean }> {
    let removed = false
    await store.update((current) => {
      removed = current.roots.some((root) => root.path === path)
      return removed ? { ...current, roots: current.roots.filter((root) => root.path !== path) } : current
    })
    return { removed }
  }

  return { list, add, remove }
}
