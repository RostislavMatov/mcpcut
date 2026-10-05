import { join } from 'node:path'
import { z } from 'zod'
import { JOURNAL_DIR } from '../../config.js'
import { createJsonStore, type JsonStore } from '../../policy/store.js'
import { absolutePathSchema } from '../rule-schema.js'
import { INDEX_RULES_FILE_NAME, INDEX_RULES_MAX } from './constants.js'

/**
 * Which folders are indexed for search by meaning (ADR-0020 §6): a rule is a
 * canonical folder path, on or off (off cuts a subfolder out of a wider
 * rule). Stored as the `files-index.json` document in `<journalDir>/state.db`
 * like the roots; every update returns a new document.
 */

const ruleSchema = z.strictObject({ path: absolutePathSchema, enabled: z.boolean(), setAt: z.iso.datetime() })

export const indexRulesFileSchema = z.strictObject({
  version: z.literal(1),
  rules: z
    .array(ruleSchema)
    .max(INDEX_RULES_MAX)
    .refine((rules) => new Set(rules.map((rule) => rule.path)).size === rules.length, 'index rule paths must be unique'),
})

export type IndexRulesFile = z.infer<typeof indexRulesFileSchema>
export type IndexRule = IndexRulesFile['rules'][number]

export function parseIndexRulesFile(raw: unknown): { ok: true; file: IndexRulesFile } | { ok: false; error: z.ZodError } {
  const result = indexRulesFileSchema.safeParse(raw)
  return result.success ? { ok: true, file: result.data } : { ok: false, error: result.error }
}

export class IndexRulesLimitError extends Error {
  constructor() {
    super(`at most ${INDEX_RULES_MAX} index rules: remove one first with \`mcpcut files index off <folder>\``)
    this.name = 'IndexRulesLimitError'
  }
}

export interface IndexRulesStore {
  /** All rules, sorted by path. */
  list(): Promise<readonly IndexRule[]>
  /** Adds the rule or replaces the one on the same path. */
  set(path: string, enabled: boolean): Promise<void>
  remove(path: string): Promise<{ readonly removed: boolean }>
}

export interface IndexRulesStoreOptions {
  readonly journalDir?: string
  readonly clock?: () => Date
}

const EMPTY_FILE: IndexRulesFile = { version: 1, rules: [] }

function validateRules(raw: unknown): IndexRulesFile {
  const result = indexRulesFileSchema.safeParse(raw)
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
    throw new Error(`index rules file failed validation: ${details.join('; ')}`)
  }
  return result.data
}

function byPath(left: IndexRule, right: IndexRule): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}

export function createIndexRulesStore(opts: IndexRulesStoreOptions = {}): IndexRulesStore {
  const clock = opts.clock ?? (() => new Date())
  const store: JsonStore<IndexRulesFile> = createJsonStore(join(opts.journalDir ?? JOURNAL_DIR, INDEX_RULES_FILE_NAME), {
    validate: validateRules,
    defaultValue: EMPTY_FILE,
  })

  async function list(): Promise<readonly IndexRule[]> {
    return [...(await store.read()).rules].sort(byPath)
  }

  async function set(path: string, enabled: boolean): Promise<void> {
    const entry: IndexRule = { path, enabled, setAt: clock().toISOString() }
    await store.update((current) => {
      const others = current.rules.filter((rule) => rule.path !== path)
      if (others.length === current.rules.length && current.rules.length >= INDEX_RULES_MAX) throw new IndexRulesLimitError()
      return { ...current, rules: [...others, entry].sort(byPath) }
    })
  }

  async function remove(path: string): Promise<{ readonly removed: boolean }> {
    let removed = false
    await store.update((current) => {
      removed = current.rules.some((rule) => rule.path === path)
      return removed ? { ...current, rules: current.rules.filter((rule) => rule.path !== path) } : current
    })
    return { removed }
  }

  return { list, set, remove }
}
