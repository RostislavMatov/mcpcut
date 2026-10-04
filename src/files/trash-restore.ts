import path from 'node:path'
import { ruleKeysOf } from './grant-admin.js'
import { restoreFromTrash } from './io-trash-admin.js'
import type { TrashManifest } from './trash-manifest.js'

/**
 * Restoring from the trash by a root the administrator NAMES (ADR-0020 §4):
 * the argument must be one of the declared roots — compared the way grants
 * compare folders (`ruleKeysOf`: canonical spelling and its variants) — so
 * nobody restores into an arbitrary folder. The CLI (`files trash restore`)
 * and the web UI (`POST /files/trash/restore`) both call this, so they cannot
 * drift.
 */

export type DeclaredRestore =
  | { readonly status: 'no-root' }
  | { readonly status: 'failed'; readonly root: string; readonly message: string }
  | { readonly status: 'restored'; readonly root: string; readonly manifest: TrashManifest; readonly target: string }

/** The declared root that `raw` names, or undefined when it names none. */
export async function findDeclaredRoot(declared: readonly string[], raw: string): Promise<string | undefined> {
  return (await ruleKeysOf(raw)).find((key) => declared.includes(key))
}

/** Resolves `rawRoot` against the declared roots, then restores entry `id`; nothing on disk is touched for an unknown root. */
export async function restoreInDeclaredRoot(declared: readonly string[], rawRoot: string, id: string): Promise<DeclaredRestore> {
  const root = await findDeclaredRoot(declared, rawRoot)
  if (root === undefined) return { status: 'no-root' }
  const restored = await restoreFromTrash(root, id)
  if (!restored.ok) return { status: 'failed', root, message: restored.message }
  return { status: 'restored', root, manifest: restored.value, target: path.join(root, restored.value.relative) }
}
