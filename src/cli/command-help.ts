import { cliCommand } from './next-step.js'
import { COMMAND_TABLE } from './usage.js'

const HELP_FLAGS: readonly string[] = ['--help', '-h']

/** A row of the table starts with exactly two spaces and the program name; continuation lines are indented deeper. */
const ROW_START = /^ {2}mcpcut (\S+)/

/**
 * True when `--help` or `-h` appears before any `--`. What follows `--` belongs
 * to a wrapped command (`wrap -- some-server --help`) and must reach it.
 */
export function wantsCommandHelp(args: readonly string[]): boolean {
  const dashIndex = args.indexOf('--')
  const own = dashIndex === -1 ? args : args.slice(0, dashIndex)
  return own.some((arg) => HELP_FLAGS.includes(arg))
}

/** The verbs a row's first word names: `start|stop` is two, `status` one. */
function verbsOf(firstWord: string): readonly string[] {
  return firstWord.split('|')
}

/**
 * The rows of the global usage that belong to `command`, under a header and
 * followed by the way back to the full list. `undefined` when the table has
 * no row for it (an unknown command).
 */
export function commandUsage(command: string): string | undefined {
  const lines = COMMAND_TABLE.split('\n').slice(1)
  const picked: string[] = []
  let isPicking = false
  for (const line of lines) {
    const row = ROW_START.exec(line)
    if (row !== null) isPicking = verbsOf(row[1] ?? '').includes(command)
    if (isPicking && line.trim() !== '') picked.push(line)
  }
  if (picked.length === 0) return undefined
  return `Usage:\n${picked.join('\n')}\n\nAll commands: ${cliCommand()} --help\n`
}
