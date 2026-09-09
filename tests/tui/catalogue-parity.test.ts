import { describe, expect, test } from 'vitest'
import { ROW_INDENT } from '../../src/cli/operator-usage.js'
import { USAGE } from '../../src/cli/usage.js'
import { cataloguePairs } from '../../src/tui/catalogue/index.js'
import type { CommandPair } from '../../src/tui/catalogue/types.js'

/**
 * Parity between the CLI and the console (mcpcut phase 2, Task 16).
 *
 * The console is a client of the same dispatcher the shell calls, so every
 * command in the global `--help` table is either in the catalogue, listed
 * here as deliberately out of scope, or listed here as not written yet. There
 * is no fourth category — a command nobody thought about fails test (2) with
 * its own name in the diff.
 *
 * The pairs are read out of the REAL `USAGE` (the `usage.test.ts` discipline)
 * rather than a copy, because a copy is exactly what stops being true.
 */

/**
 * Commands the console will never run itself.
 *
 * `wrap` and `connect` are long-lived stdio proxies wired to an AGENT's own
 * stdin and stdout (PRD): a screen that redraws cannot host one. `ui` and
 * `serve` ARE the daemons this console is a client of — they are reached
 * through `start|stop|logs` in Services (phase 5), never run in the
 * foreground of a console session. `tui` is the console itself.
 */
const EXCLUDED_FROM_CATALOGUE: readonly CommandPair[] = [
  { command: 'wrap' },
  { command: 'connect' },
  { command: 'ui' },
  { command: 'serve' },
  { command: 'tui' },
]

/**
 * Commands the console cannot run YET: Services (phase 5).
 *
 * Phase 4 closed the rest — the nine remaining sections landed, so what is
 * left is the four commands that manage this install's own daemons and the
 * setup the first-run wizard owns. Written out in full on purpose: this list
 * is the phase's admission of what is missing.
 */
const NOT_YET_COVERED: readonly CommandPair[] = [
  // --- Phase 5: Services (and the setup the first-run wizard will own) ---
  { command: 'setup' },
  { command: 'start' },
  { command: 'stop' },
  { command: 'logs' },
]

/** A row of the table: two spaces, a binary name, the command, then the rest. */
const ROW_PATTERN = new RegExp(`^${ROW_INDENT}(?:mcp-journal|mcpcut) (\\S+)(?: (.*))?$`)

/** A bare word — a subcommand looks like this, a `<placeholder>` or a `--flag` does not. */
const BARE_WORD_PATTERN = /^[a-z][a-z-]*$/

/** A `<name>`-style argument: what a subcommand can hide behind inside one token. */
const PLACEHOLDER_PATTERN = /^<.+>$/

/**
 * Every (command, subcommand) pair the usage table describes.
 *
 * The table is written for humans, so one row can carry several commands
 * (`start|stop`) and several subcommands (`vault init|set <name>|list|…`).
 * The rules below are deliberately narrow: a word is a subcommand only where
 * a subcommand can stand — first in the argument list, after a `|` that
 * separates whole forms, or after a placeholder inside an alternation
 * (`<name>|rotate`). Everything else — flag values (`--role owner|operator`),
 * bracketed choices (`[ui|serve]`), description prose — is not.
 */
export function usagePairs(usage: string): readonly CommandPair[] {
  const pairs = usage.split('\n').flatMap(pairsOfRow)
  const seen = new Set<string>()

  return pairs.filter((pair) => {
    const key = keyOf(pair)
    if (seen.has(key)) return false

    seen.add(key)
    return true
  })
}

function pairsOfRow(line: string): readonly CommandPair[] {
  const row = ROW_PATTERN.exec(synopsisOf(line))
  if (row === null) return []

  const commands = (row[1] ?? '').split('|').filter((command) => !command.startsWith('-'))
  const subcommands = subcommandsOf((row[2] ?? '').split(/\s+/).filter((token) => token !== ''))

  return commands.flatMap((command) =>
    subcommands.length === 0
      ? [{ command }]
      : subcommands.map((subcommand) => ({ command, subcommand })),
  )
}

/**
 * The row without the description beside it. The table aligns every
 * description on one column (`usage.test.ts` guards that), so a cut there
 * that lands on whitespace separated the two halves; a row whose synopsis
 * reaches past the column has no description on it and stays whole.
 */
function synopsisOf(line: string): string {
  // The description starts at the first run of two or more spaces after the
  // indent — wherever the column lands. A fixed-column cut would parse the
  // prose of every row whose synopsis runs long, and prose has `|` in it.
  const cut = line.slice(ROW_INDENT.length).search(/\s{2,}/)
  return cut === -1 ? line : line.slice(0, ROW_INDENT.length + cut)
}

/** Walks the argument tokens of one row, collecting the words that name a subcommand. */
function subcommandsOf(tokens: readonly string[]): readonly string[] {
  const subcommands: string[] = []
  let expectSubcommand = true

  for (const token of tokens) {
    if (token === '|') {
      expectSubcommand = true
      continue
    }

    const parts = token.split('|')
    subcommands.push(...(expectSubcommand ? leadingSubcommands(parts) : trailingSubcommands(parts)))
    expectSubcommand = false
  }

  return subcommands
}

/**
 * A token standing where a subcommand may start: its first part is one when
 * it is a bare word, and so is every bare part of the same alternation
 * (`init|set`, `list|show`).
 */
function leadingSubcommands(parts: readonly string[]): readonly string[] {
  if (parts[0] === undefined || !BARE_WORD_PATTERN.test(parts[0])) return []

  return parts.filter((part) => BARE_WORD_PATTERN.test(part))
}

/**
 * A token standing where an ARGUMENT is expected: only a bare part that
 * follows a placeholder part is another form of the command
 * (`<name>|rotate`). A bare part with no placeholder before it is a value of
 * the flag beside it (`--role owner|operator|viewer`) and names nothing.
 */
function trailingSubcommands(parts: readonly string[]): readonly string[] {
  const afterPlaceholder = parts.findIndex((part) => PLACEHOLDER_PATTERN.test(part))
  if (afterPlaceholder === -1) return []

  return parts.slice(afterPlaceholder + 1).filter((part) => BARE_WORD_PATTERN.test(part))
}

function keyOf(pair: CommandPair): string {
  return pair.subcommand === undefined ? pair.command : `${pair.command}:${pair.subcommand}`
}

/** Sorted keys, so a failing set comparison prints a diff a reader can act on. */
function keysOf(pairs: readonly CommandPair[]): readonly string[] {
  return [...pairs].map(keyOf).sort()
}

function withoutKeys(
  pairs: readonly CommandPair[],
  removed: readonly CommandPair[],
): readonly CommandPair[] {
  const excluded = new Set(removed.map(keyOf))
  return pairs.filter((pair) => !excluded.has(keyOf(pair)))
}

describe('usagePairs reads the table the way a human does', () => {
  const pairs = keysOf(usagePairs(USAGE))

  test.each([
    'admin:add',
    'admin:list',
    'admin:remove',
    'admin:rotate',
    'admin:role',
    'vault:init',
    'vault:set',
    'vault:list',
    'vault:remove',
    'vault:rekey',
    'agent:ungrant',
    'agent:revoke',
    'agent:list',
    'group:join',
    'group:leave',
    'group:ungrant',
    'quarantine:show',
    'start',
    'stop',
    'sessions',
    'tui',
  ])('finds %s', (key) => {
    expect(pairs).toContain(key)
  })

  test.each([
    ['policy:allow', 'a value of `policy set`, not a subcommand'],
    ['admin:owner', 'a value of `--role`'],
    ['server:stdio', 'a value of `--transport`'],
    ['start:ui', 'a bracketed argument, not a subcommand'],
  ])('does not mistake %s for a command (%s)', (key) => {
    expect(pairs).not.toContain(key)
  })
})

describe('every command of the CLI is accounted for', () => {
  test('what the table describes, minus the excluded and the covered, is exactly the backlog', () => {
    const remaining = withoutKeys(
      withoutKeys(usagePairs(USAGE), EXCLUDED_FROM_CATALOGUE),
      cataloguePairs(),
    )

    expect(keysOf(remaining)).toEqual(keysOf(NOT_YET_COVERED))
  })

  test('nothing is both covered and listed as missing', () => {
    const covered = new Set(keysOf(cataloguePairs()))
    const both = keysOf(NOT_YET_COVERED).filter((key) => covered.has(key))

    expect(both).toEqual([])
  })

  test('every action of the catalogue runs a command the table describes', () => {
    const described = new Set(keysOf(usagePairs(USAGE)))
    const undescribed = keysOf(cataloguePairs()).filter((key) => !described.has(key))

    expect(undescribed).toEqual([])
  })

  test('nothing is excluded that the table does not describe', () => {
    const described = new Set(keysOf(usagePairs(USAGE)))
    const unknown = keysOf(EXCLUDED_FROM_CATALOGUE).filter((key) => !described.has(key))

    expect(unknown).toEqual([])
  })
})

describe('usagePairs: the description of a row is never mistaken for its synopsis', () => {
  test('a pipe or a placeholder in the prose yields no phantom pair', () => {
    const usage = [
      `${ROW_INDENT}mcp-journal approvals list [--json]   List pending approval | requests, one row each`,
      `${ROW_INDENT}mcp-journal backup <destDir>   Back up into <dir>|zip`,
      `${ROW_INDENT}mcp-journal status [--json]   Print a table | one row per service`,
    ].join('\n')

    expect(usagePairs(usage)).toEqual([
      { command: 'approvals', subcommand: 'list' },
      { command: 'backup' },
      { command: 'status' },
    ])
  })

  test('a synopsis longer than the description column keeps all its subcommands', () => {
    const usage = `${ROW_INDENT}mcp-journal group create|remove|list|show|grant|ungrant|join|leave <name>  Manage groups`

    expect(usagePairs(usage).map((pair) => pair.subcommand)).toEqual([
      'create',
      'remove',
      'list',
      'show',
      'grant',
      'ungrant',
      'join',
      'leave',
    ])
  })
})
