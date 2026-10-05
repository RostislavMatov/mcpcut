import { JOURNAL_DIR } from '../config.js'
import { createAgentsStore } from '../agents/store.js'
import { describeDbUrl, parseDbUrl, readDbUrl } from '../files/db/db-url.js'
import { FilesDbError } from '../files/db/errors.js'
import { modulesDirOf } from '../files/db/pg-loader.js'
import { createRootsStore } from '../files/roots-store.js'
import { SEARCH_MODEL_ID } from '../files/search/constants.js'
import { readRuleCounts, type RuleCounts } from '../files/search/index-counts.js'
import { createIndexRulesStore, type IndexRule } from '../files/search/index-rules-store.js'
import { searchRuntimeProblem } from '../files/search/readiness.js'
import { formatReadableField } from '../journal/format.js'
import type { AgentCliIo } from './agent-cmd.js'
import { grantNextStep } from './files-cmd-format.js'
import { loadClient, schemaOf } from './files-cmd-db-shared.js'
import type { FilesCliOptions } from './files-cmd.js'
import { cliCommand, shellArg } from './next-step.js'

/** `mcpcut files index list`: the rules, per rule the counts when Postgres answers, the runtime line, one next step. No token. */

type Counts = { readonly kind: 'counts'; readonly byRule: ReadonlyMap<string, RuleCounts> } | { readonly kind: 'none'; readonly note: string }

async function countsOf(opts: FilesCliOptions, rules: readonly IndexRule[], roots: readonly string[]): Promise<Counts> {
  const cli = cliCommand(opts.env)
  const journalDir = opts.journalDir ?? JOURNAL_DIR
  const state = await readDbUrl({ journalDir, cli })
  if (state.status !== 'on') return { kind: 'none', note: `counts need Postgres: ${cli} files db init` }
  if (!parseDbUrl(state.url, cli).ok) return { kind: 'none', note: 'counts unavailable: the Postgres URL is invalid' }
  const client = await loadClient(opts)
  if ('line' in client) return { kind: 'none', note: `counts unavailable: ${client.line}` }
  try {
    const byRule = await readRuleCounts(
      { pg: client.pg, url: state.url, schema: schemaOf(opts), cli },
      { roots, rules, platform: process.platform, model: SEARCH_MODEL_ID },
    )
    if (byRule === undefined) return { kind: 'none', note: `nothing is indexed yet: ${cli} files db sync` }
    return { kind: 'counts', byRule }
  } catch (error: unknown) {
    if (!(error instanceof FilesDbError)) throw error
    return { kind: 'none', note: `counts unavailable: ${formatReadableField(error.message)} (${formatReadableField(describeDbUrl(state.url))})` }
  }
}

function ruleLine(rule: IndexRule, counts: Counts): string {
  const path = formatReadableField(rule.path)
  if (!rule.enabled) return `off  ${path}  (cut out)`
  const found = counts.kind === 'counts' ? counts.byRule.get(rule.path) : undefined
  if (found === undefined) return `on   ${path}`
  return `on   ${path}  ${found.indexed} files, ${found.chunks} chunks, ${found.skipped} skipped, ${found.pending} pending`
}

async function nextStepOf(opts: FilesCliOptions, rules: readonly IndexRule[], counts: Counts, runtimeProblem: string | null): Promise<string> {
  const cli = cliCommand(opts.env)
  const first = rules.find((rule) => rule.enabled)
  if (first === undefined) return `Turn a folder on again: ${cli} files index on ${shellArg(rules[0]?.path ?? '<folder>')}\n`
  if (counts.kind === 'none' && counts.note.startsWith('counts need Postgres')) return `Next: ${cli} files db init\n`
  if (runtimeProblem !== null) return `Next: ${cli} files setup --search\n`
  const pending = counts.kind === 'counts' ? [...counts.byRule.values()].some((found) => found.pending > 0) : true
  if (pending) return `Next: ${cli} files db sync\n`
  const agents = await createAgentsStore({ journalDir: opts.journalDir ?? JOURNAL_DIR }).listAgents()
  return grantNextStep(opts.env ?? process.env, agents, first.path)
}

export async function runIndexList(io: AgentCliIo, opts: FilesCliOptions): Promise<number> {
  const cli = cliCommand(opts.env)
  const journalDir = opts.journalDir ?? JOURNAL_DIR
  const rules = await createIndexRulesStore({ journalDir }).list()
  if (rules.length === 0) {
    const roots = await createRootsStore({ journalDir }).list()
    io.stdout.write('(no folder is indexed)\n')
    io.stderr.write(`no folder is indexed: run \`${cli} files index on ${shellArg(roots[0]?.path ?? '<folder>')}\`\n`)
    return 0
  }
  const roots = (await createRootsStore({ journalDir }).list()).map((root) => root.path)
  const counts = await countsOf(opts, rules, roots)
  const problem = await (opts.db?.searchProblem ?? searchRuntimeProblem)(modulesDirOf(journalDir), cli)
  rules.forEach((rule) => io.stdout.write(`${ruleLine(rule, counts)}\n`))
  if (counts.kind === 'none') io.stdout.write(`${counts.note}\n`)
  io.stdout.write(`runtime: ${problem === null ? 'ready' : formatReadableField(problem)}\n`)
  io.stderr.write(await nextStepOf(opts, rules, counts, problem))
  return 0
}
