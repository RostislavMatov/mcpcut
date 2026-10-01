import { sep } from 'node:path'
import type { ApplyResult, FileProblem, ScanResult, ScannedLocation } from '../adopt/apply.js'
import { CLIENT_LABELS, type ClientId } from '../adopt/clients.js'
import type { Launcher } from '../adopt/entry.js'
import type { PlanRow } from '../adopt/plan.js'
import type { UndoResult } from '../adopt/undo.js'
import { redactText } from '../redact/patterns.js'
import { cliCommand, shellArg } from './next-step.js'

/**
 * What `mcpcut adopt` prints. Pure text from results: the table on stdout,
 * the next step on stderr (as every command does). Command lines pass
 * through the redactor — a config may carry a key in an argument, and this
 * output gets pasted into issues and screenshots.
 */

const MAX_NAME_WIDTH = 20
const EXAMPLE_SERVER = 'npx -y @modelcontextprotocol/server-filesystem'

export interface RenderPlace {
  readonly home: string
  readonly cwd: string
}

export interface Rendered {
  readonly stdout: string
  readonly stderr: string
}

/** `~` for the home folder, so the paths read as the user knows them. */
export function displayPath(file: string, home: string): string {
  return file === home || file.startsWith(`${home}${sep}`) ? `~${file.slice(home.length)}` : file
}

function commandLineText(command: string, args: readonly string[] = []): string {
  return redactText([command, ...args].map(shellArg).join(' '))
}

function rowText(row: PlanRow, width: number): string {
  const name = row.name.padEnd(width)
  if (row.verdict.kind === 'wrap') return `  ${name}  wrap     ${commandLineText(row.before?.command ?? '', row.before?.args)}`
  if (row.verdict.kind === 'already') return `  ${name}  already  starts through mcpcut`
  if (row.verdict.kind === 'remote') return `  ${name}  skip     remote server (by URL); mcpcut wraps servers a client starts`
  return `  ${name}  skip     not a server entry adopt understands; left as is`
}

function locationText(scanned: ScannedLocation, place: RenderPlace): string {
  const { location, rows } = scanned
  const width = Math.min(MAX_NAME_WIDTH, Math.max(...rows.map((row) => row.name.length)))
  const header = `${CLIENT_LABELS[location.client]} (${location.scope}) ${displayPath(location.file, place.home)}`
  return [header, ...rows.map((row) => rowText(row, width))].join('\n')
}

function problemsText(problems: readonly FileProblem[], place: RenderPlace): string {
  if (problems.length === 0) return ''
  const lines = problems.map((p) => `  ${displayPath(p.file, place.home)}: ${p.reason}; left as is`)
  return `\nNot read:\n${lines.join('\n')}\n`
}

function countOf(scan: ScanResult, kind: PlanRow['verdict']['kind']): number {
  return scan.locations.flatMap((s) => s.rows).filter((row) => row.verdict.kind === kind).length
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** `1 server now starts`, `2 servers now start`. */
function serversStart(count: number, adverb: string): string {
  return `${plural(count, 'server')} ${adverb} ${count === 1 ? 'starts' : 'start'}`
}

function nothingFound(scan: ScanResult, place: RenderPlace): Rendered {
  const looked = scan.looked.map((file) => displayPath(file, place.home)).join(', ')
  return {
    stdout: `No MCP servers found in Claude Code, Cursor or Claude Desktop.\nLooked in: ${looked}\n${problemsText(scan.problems, place)}`,
    stderr: `Add one behind mcpcut: claude mcp add fs -- ${cliCommand()} wrap --server fs -- ${EXAMPLE_SERVER} ${shellArg(place.cwd)}\n`,
  }
}

/** The dry run: what would change, then the command that writes it. */
export function renderPlan(scan: ScanResult, place: RenderPlace, launcher: Launcher): Rendered {
  if (scan.locations.length === 0) return nothingFound(scan, place)
  const toWrap = countOf(scan, 'wrap')
  const table = scan.locations.map((s) => locationText(s, place)).join('\n')
  const problems = problemsText(scan.problems, place)
  if (toWrap === 0) {
    return {
      stdout: `Nothing to change: ${serversStart(countOf(scan, 'already'), 'already')} through mcpcut.\n\n${table}\n${problems}`,
      stderr: `See what they did: ${cliCommand()} sessions\n`,
    }
  }
  const intro = `${plural(toWrap, 'server')} to put behind mcpcut. Nothing is written yet.\nEach command becomes: ${commandLineText(launcher.command, launcher.args)} wrap --server <name> -- <its command>`
  return { stdout: `${intro}\n\n${table}\n${problems}\n`, stderr: `Write it: ${cliCommand()} adopt --apply\n` }
}

function clientsOf(scan: ScanResult, files: readonly string[]): readonly ClientId[] {
  return [...new Set(scan.locations.filter((s) => files.includes(s.location.file)).map((s) => s.location.client))]
}

function failuresText(failures: readonly FileProblem[], place: RenderPlace, retry: string): string {
  if (failures.length === 0) return ''
  const lines = failures.map((f) => `Could not change ${displayPath(f.file, place.home)}: ${f.reason}.`)
  return `${lines.join('\n')}\nClose the client that holds it, then: ${retry}\n`
}

/** After `--apply`: what changed, where the copies are, restart, look, undo. */
export function renderApplied(scan: ScanResult, result: ApplyResult, place: RenderPlace): Rendered {
  const failures = failuresText(result.failures, place, `${cliCommand()} adopt --apply`)
  if (result.written.length === 0) return { stdout: '', stderr: failures }
  const servers = result.written.flatMap((w) => w.servers)
  const files = result.written.map((w) => `  ${displayPath(w.file, place.home)}: ${w.servers.join(', ')}`)
  const clients = clientsOf(scan, result.written.map((w) => w.file)).map((id) => CLIENT_LABELS[id]).join(' and ')
  const copies = result.backupDir === undefined ? '' : `Copies of the files as they were: ${displayPath(result.backupDir, place.home)}\n`
  return {
    stdout: `${serversStart(servers.length, 'now')} through mcpcut:\n${files.join('\n')}\n${copies}`,
    stderr: `${failures}Next: restart ${clients} to load the change, let the agent work, then: ${cliCommand()} sessions\nUndo: ${cliCommand()} adopt --undo\n`,
  }
}

function keptText(result: Extract<UndoResult, { kind: 'done' }>, place: RenderPlace): string {
  if (result.kept.length === 0) return ''
  const lines = result.kept.map((k) => `  ${displayPath(k.file, place.home)}: ${k.name}`)
  return `Left as you changed them since:\n${lines.join('\n')}\n`
}

export function renderUndo(result: UndoResult, place: RenderPlace): Rendered {
  if (result.kind === 'nothing') {
    return { stdout: 'Nothing to undo: adopt has not changed a client config here, or every change is undone.\n', stderr: `Put servers behind mcpcut: ${cliCommand()} adopt\n` }
  }
  if (result.kind === 'problem') {
    const dir = displayPath(result.dir, place.home)
    return { stdout: '', stderr: `Cannot undo from ${dir}: ${result.reason}. The files as they were before adopt are copied there.\n` }
  }
  const restored = result.restored.map((r) => `  ${displayPath(r.file, place.home)}: ${r.servers.join(', ')}`)
  const head = restored.length === 0 ? 'Nothing restored.\n' : `Restored:\n${restored.join('\n')}\n`
  const failures = failuresText(result.failures, place, `${cliCommand()} adopt --undo`)
  const next = restored.length === 0 ? '' : 'Next: restart the client so it starts these servers directly again.\n'
  return { stdout: `${head}${keptText(result, place)}`, stderr: `${failures}${next}` }
}
