import type { z } from 'zod'
import { formatReadableField } from '../journal/format.js'
import { SEARCH_DEFAULT_LIMIT, SNIPPET_MAX_CHARS } from './search/constants.js'
import { hasReadableIndexed, searchChunks, type SearchHit, type SearchScope } from './search/search-query.js'
import type { SearchOpen } from './search/search-backend.js'
import { SEARCH_FILES_OPS } from './tool-access.js'
import { authorize, errorOutput, jsonOutput, textOutput, type ToolContext, type ToolOutput } from './tool-context.js'
import type { searchFilesSchema } from './tools.js'

/**
 * `search_files` (ADR-0020 §2, §6): passages by meaning from the indexed
 * folders the agent can read. The rights are enforced in the SQL filter and
 * again on every row (`search-query.ts`); this handler only sequences the
 * steps and words the answers, each ending with what to do next.
 */

const NOT_INDEXED_MESSAGE =
  'None of the folders you can read is indexed yet: ask an administrator to run `mcpcut files index on <folder>`.'
const NOTHING_MATCHED_MESSAGE =
  'Nothing matched in the indexed folders you can read: try other words, or call list_roots to see your folders.'
const NOT_SET_UP_PROBLEM = 'this file server has no search set up: ask an administrator to run `mcpcut files setup --search`'
const SCORE_DECIMALS = 1000

const unavailable = (problem: string): ToolOutput => errorOutput(`search by meaning is not available: ${problem}`)

/** Cuts to the snippet size without leaving half of a surrogate pair. */
function snippetOf(body: string): string {
  if (body.length <= SNIPPET_MAX_CHARS) return body
  const cut = body.slice(0, SNIPPET_MAX_CHARS)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

function resultOf(hit: SearchHit): { path: string; lines: string; score: number; text: string } {
  return {
    path: hit.path,
    lines: `${hit.startLine}-${hit.endLine}`,
    score: Math.round((1 - hit.distance) * SCORE_DECIMALS) / SCORE_DECIMALS,
    text: snippetOf(hit.body),
  }
}

async function searchReady(
  opened: Extract<SearchOpen, { kind: 'ready' }>,
  scope: SearchScope,
  args: z.output<typeof searchFilesSchema>,
): Promise<ToolOutput> {
  const vector = await opened.embedder.embedQuery(args.query)
  const hits = await searchChunks(opened.sdb, { ...scope, vector, limit: args.limit ?? SEARCH_DEFAULT_LIMIT })
  if (hits.length > 0) return jsonOutput({ results: hits.map(resultOf) })
  // Counted over every folder the agent can read, not just `path`: an empty subfolder is "nothing matched", not "nothing indexed".
  const { under: _narrowed, ...everywhere } = scope
  return textOutput((await hasReadableIndexed(opened.sdb, everywhere)) ? NOTHING_MATCHED_MESSAGE : NOT_INDEXED_MESSAGE)
}

export async function searchFilesTool(ctx: ToolContext, args: z.output<typeof searchFilesSchema>): Promise<ToolOutput> {
  if (!ctx.prepared.ok) return errorOutput(ctx.prepared.message)
  let under: string | undefined
  if (args.path !== undefined) {
    const access = await authorize(ctx, args.path, SEARCH_FILES_OPS)
    if (!access.ok) return access.output
    under = access.value.absolute
  }
  if (ctx.search === undefined) return unavailable(NOT_SET_UP_PROBLEM)
  const opened = await ctx.search.open()
  if (opened.kind === 'unavailable') return unavailable(opened.problem)
  if (opened.kind === 'empty') return textOutput(NOT_INDEXED_MESSAGE)
  const scope: SearchScope = {
    roots: ctx.roots,
    rules: ctx.rules,
    prepared: ctx.prepared.rules,
    platform: process.platform,
    ...(under !== undefined ? { under } : {}),
  }
  try {
    return await searchReady(opened, scope, args)
  } catch (error: unknown) {
    return unavailable(formatReadableField(error instanceof Error ? error.message : String(error)))
  }
}
