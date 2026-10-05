import path from 'node:path'
import { isWithinOn, lexicalKey } from './names.js'
import { canonicalPath } from './paths.js'

/**
 * mcpcut's own data folder (`<data dir>`) holds code it loads at run time (the
 * Postgres client in `modules/`) and its state. A root that is the folder,
 * lies inside it or holds it would give an agent with write rights the means
 * to replace that code — so such a root is never declared and never served.
 */

/** Does either of two canonical folders contain the other (or are they the same)? Folded where the platform folds. */
export function overlapsDataDir(root: string, dataDir: string, platform: NodeJS.Platform = process.platform): boolean {
  const rootKey = lexicalKey(root, platform)
  const dataKey = lexicalKey(dataDir, platform)
  return isWithinOn(dataKey, rootKey, platform) || isWithinOn(rootKey, dataKey, platform)
}

/** The data folder as the disk names it; a folder that does not exist yet is judged by its nearest existing parent. */
export async function canonicalDataDir(dataDir: string): Promise<string> {
  return (await canonicalPath(dataDir)) ?? path.resolve(dataDir)
}

/** The roots that do not overlap mcpcut's data, in their order. */
export async function rootsOutsideDataDir(roots: readonly string[], dataDir: string): Promise<readonly string[]> {
  const data = await canonicalDataDir(dataDir)
  const checks = await Promise.all(roots.map(async (root) => overlapsDataDir((await canonicalPath(root)) ?? path.resolve(root), data)))
  return roots.filter((_root, index) => !checks[index])
}

/** The one line a refusal prints: both folders, and what to do. */
export function overlapMessage(root: string, dataDir: string): string {
  return `${root} overlaps mcpcut's own data folder ${dataDir}: choose a folder outside it`
}
