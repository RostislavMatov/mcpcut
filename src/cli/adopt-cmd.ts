import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { applyAdopt, scanConfigs, type AdoptOptions } from '../adopt/apply.js'
import { CLIENT_IDS, type AdoptPlace, type ClientId } from '../adopt/clients.js'
import { launcherOf } from '../adopt/entry.js'
import { undoAdopt } from '../adopt/undo.js'
import { PRODUCT_VERSION } from '../brand.js'
import { errnoCodeOf } from '../errno.js'
import { JOURNAL_DIR } from '../config.js'
import { renderApplied, renderPlan, renderUndo, type Rendered } from './adopt-render.js'
import { cliCommand } from './next-step.js'

/**
 * `mcpcut adopt [--apply] [--client <id>]` and `mcpcut adopt --undo` (P3):
 * put the MCP servers a user already has in Claude Code, Cursor and Claude
 * Desktop behind `mcpcut wrap`, in one command instead of editing each entry.
 * Without `--apply` it only shows the change — it edits the user's own files.
 */

export interface AdoptCliWritable {
  write(chunk: string): unknown
}

export interface AdoptCliIo {
  readonly stdout: AdoptCliWritable
  readonly stderr: AdoptCliWritable
}

export interface AdoptCommandOptions {
  /** mcpcut's data dir (copies and the undo manifest go there); defaults to `JOURNAL_DIR`. */
  readonly journalDir?: string
  /** Seams for tests: the home and working folders, the platform, `%APPDATA%`. */
  readonly place?: AdoptPlace
  readonly version?: string
  readonly now?: () => Date
}

const EXIT_OK = 0
const EXIT_FAILED = 1

interface AdoptFlags {
  readonly apply: boolean
  readonly undo: boolean
  readonly clients?: readonly ClientId[]
}

function usage(): string {
  return `Usage:\n  ${cliCommand()} adopt [--apply] [--client ${CLIENT_IDS.join('|')}]\n  ${cliCommand()} adopt --undo\n`
}

function isClientId(value: string): value is ClientId {
  return (CLIENT_IDS as readonly string[]).includes(value)
}

/** The flags, or the one-line reason they cannot run. */
function parseAdoptFlags(args: readonly string[]): AdoptFlags | string {
  let values: { apply?: boolean; undo?: boolean; client?: string[] }
  try {
    values = parseArgs({
      args: [...args],
      options: { apply: { type: 'boolean' }, undo: { type: 'boolean' }, client: { type: 'string', multiple: true } },
      allowPositionals: false,
      strict: true,
    }).values
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  const unknown = (values.client ?? []).filter((client) => !isClientId(client))
  if (unknown.length > 0) return `Unknown client "${unknown.join('", "')}"; one of: ${CLIENT_IDS.join(', ')}`
  if (values.undo === true && (values.apply === true || values.client !== undefined)) return '--undo takes no other option'
  const clients = values.client?.filter(isClientId)
  return { apply: values.apply === true, undo: values.undo === true, ...(clients === undefined ? {} : { clients }) }
}

function write(io: AdoptCliIo, rendered: Rendered): void {
  if (rendered.stdout !== '') io.stdout.write(rendered.stdout)
  if (rendered.stderr !== '') io.stderr.write(rendered.stderr)
}

function placeOf(opts: AdoptCommandOptions): AdoptPlace {
  const appData = process.env['APPDATA']
  return opts.place ?? { home: homedir(), cwd: process.cwd(), platform: process.platform, ...(appData === undefined ? {} : { appData }) }
}

function describeError(error: unknown): string {
  return errnoCodeOf(error) ?? (error instanceof Error ? error.message : String(error))
}

/** One line instead of a stack trace: each file is replaced in one rename, so none is left half-written. */
export async function runAdoptCommand(args: readonly string[], io: AdoptCliIo, opts: AdoptCommandOptions = {}): Promise<number> {
  const flags = parseAdoptFlags(args)
  if (typeof flags === 'string') {
    io.stderr.write(`${flags}\n\n${usage()}`)
    return EXIT_FAILED
  }
  try {
    return await runAdopt(flags, io, opts)
  } catch (error) {
    const retry = flags.undo ? 'adopt --undo' : flags.apply ? 'adopt --apply' : 'adopt'
    io.stderr.write(`adopt could not finish (${describeError(error)}).\nTry again: ${cliCommand()} ${retry}\n`)
    return EXIT_FAILED
  }
}

async function runAdopt(flags: AdoptFlags, io: AdoptCliIo, opts: AdoptCommandOptions): Promise<number> {
  const place = placeOf(opts)
  const dataDir = opts.journalDir ?? JOURNAL_DIR
  if (flags.undo) {
    const result = await undoAdopt({ dataDir, ...(opts.now === undefined ? {} : { now: opts.now }) })
    write(io, renderUndo(result, place))
    return result.kind === 'problem' || (result.kind === 'done' && result.failures.length > 0) ? EXIT_FAILED : EXIT_OK
  }
  const version = opts.version ?? PRODUCT_VERSION
  const adoptOptions: AdoptOptions = {
    place,
    dataDir,
    version,
    ...(flags.clients === undefined ? {} : { clients: flags.clients }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  }
  const scan = await scanConfigs(adoptOptions)
  const hasWork = scan.locations.some((s) => s.rows.some((row) => row.verdict.kind === 'wrap'))
  if (!flags.apply || !hasWork) {
    write(io, renderPlan(scan, place, launcherOf(version, place.platform)))
    return EXIT_OK
  }
  const result = await applyAdopt(scan, adoptOptions)
  write(io, renderApplied(scan, result, place))
  return result.failures.length > 0 || result.copyProblem !== undefined ? EXIT_FAILED : EXIT_OK
}
