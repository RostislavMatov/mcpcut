import { join } from 'node:path'
import { errnoCodeOf } from '../errno.js'
import { locationsOf, type AdoptPlace, type ClientId, type ServersLocation } from './clients.js'
import { launcherOf } from './entry.js'
import {
  ensureOwnerOnlyDir,
  readConfigFile,
  renderLike,
  replaceFileAtomically,
  writeOwnerOnlyCopy,
  type ConfigFile,
} from './files.js'
import { ADOPT_DIR_NAME, manifestOf, writeManifest, type ManifestChange } from './manifest.js'
import { commandLineOf, planServers, serversAt, withEntries, type CommandLine, type PlanRow } from './plan.js'

/**
 * `mcpcut adopt` (P3): scan every client config for MCP servers, then — on
 * `--apply` only — rewrite the ones that hold servers to wrap. Each file is
 * written once, after a copy of it is kept, and only if nobody changed it
 * since the scan (a client rewrites its own config while running).
 */

export interface AdoptOptions {
  readonly place: AdoptPlace
  /** mcpcut's data dir; copies and the manifest go under `<dataDir>/adopt/<time>/`. */
  readonly dataDir: string
  /** The mcpcut version the wrapped entries pin. */
  readonly version: string
  /** Only these clients; all when absent. */
  readonly clients?: readonly ClientId[]
  readonly now?: () => Date
}

export interface ScannedLocation {
  readonly location: ServersLocation
  readonly rows: readonly PlanRow[]
}

export interface FileProblem {
  readonly file: string
  readonly reason: string
}

export interface ScanResult {
  /** Places that hold at least one server, in `locationsOf` order. */
  readonly locations: readonly ScannedLocation[]
  readonly problems: readonly FileProblem[]
  /** Every file looked at, found or not — the empty answer names them. */
  readonly looked: readonly string[]
  /** What each file held at scan time; `--apply` writes only over exactly this. */
  readonly files: ReadonlyMap<string, ConfigFile>
}

export interface WrittenFile {
  readonly file: string
  readonly servers: readonly string[]
}

export interface ApplyResult {
  readonly written: readonly WrittenFile[]
  readonly failures: readonly FileProblem[]
  /** Present when something was written: where the copies and the manifest are. */
  readonly backupDir?: string
}

const CHANGED_SINCE_SCAN = 'changed while adopt ran (the client may have rewritten it); run adopt again'

export async function scanConfigs(opts: AdoptOptions): Promise<ScanResult> {
  const launcher = launcherOf(opts.version, opts.place.platform)
  const wanted = locationsOf(opts.place).filter((location) => opts.clients?.includes(location.client) ?? true)
  const looked = [...new Set(wanted.map((location) => location.file))]
  const files = new Map(await Promise.all(looked.map(async (file) => [file, await readConfigFile(file)] as const)))
  const problems = looked.flatMap((file) => {
    const state = files.get(file)
    return state?.kind === 'problem' ? [{ file, reason: state.reason }] : []
  })
  const locations = wanted.flatMap((location) => {
    const state = files.get(location.file)
    const servers = state?.kind === 'ok' ? serversAt(state.doc, location.path) : undefined
    const rows = servers === undefined ? [] : planServers(servers, launcher, opts.place.platform)
    return rows.length > 0 ? [{ location, rows }] : []
  })
  return { locations, problems, looked, files }
}

function wrapRowsOf(scanned: ScannedLocation): readonly PlanRow[] {
  return scanned.rows.filter((row) => row.verdict.kind === 'wrap')
}

/** Locations with something to wrap, grouped by file (one file can hold several scopes). */
function byFile(scan: ScanResult): ReadonlyMap<string, readonly ScannedLocation[]> {
  const groups = new Map<string, readonly ScannedLocation[]>()
  for (const scanned of scan.locations.filter((s) => wrapRowsOf(s).length > 0)) {
    groups.set(scanned.location.file, [...(groups.get(scanned.location.file) ?? []), scanned])
  }
  return groups
}

function replacementsOf(scanned: ScannedLocation): Readonly<Record<string, unknown>> {
  return Object.fromEntries(wrapRowsOf(scanned).flatMap((row) => (row.verdict.kind === 'wrap' ? [[row.name, row.verdict.next]] : [])))
}

/** The manifest's own mutable copy of a command line. */
function storedLine(line: CommandLine): ManifestChange['before'] {
  return line.args === undefined ? { command: line.command } : { command: line.command, args: [...line.args] }
}

function changesOf(scanned: ScannedLocation): readonly ManifestChange[] {
  return wrapRowsOf(scanned).flatMap((row) => {
    if (row.verdict.kind !== 'wrap' || row.before === undefined) return []
    const { location } = scanned
    const after = storedLine(commandLineOf(row.verdict.next))
    return [{ file: location.file, path: [...location.path], name: row.name, client: location.client, scope: location.scope, before: storedLine(row.before), after }]
  })
}

function writeFailureOf(error: unknown): string {
  return `could not write it (${errnoCodeOf(error) ?? String(error)})`
}

interface FileOutcome {
  readonly written?: WrittenFile
  readonly failure?: FileProblem
  readonly changes: readonly ManifestChange[]
}

async function adoptFile(file: string, group: readonly ScannedLocation[], scan: ScanResult, backupDir: string, index: number): Promise<FileOutcome> {
  const scanned = scan.files.get(file)
  const current = await readConfigFile(file)
  if (scanned?.kind !== 'ok' || current.kind !== 'ok' || current.text !== scanned.text) {
    return { failure: { file, reason: CHANGED_SINCE_SCAN }, changes: [] }
  }
  const next = group.reduce((doc, s) => withEntries(doc, s.location.path, replacementsOf(s)), scanned.doc)
  try {
    await ensureOwnerOnlyDir(backupDir)
    await writeOwnerOnlyCopy(backupDir, index, file, scanned.text)
    await replaceFileAtomically(file, renderLike(scanned.text, next))
  } catch (error) {
    return { failure: { file, reason: writeFailureOf(error) }, changes: [] }
  }
  const servers = group.flatMap((s) => wrapRowsOf(s).map((row) => row.name))
  return { written: { file, servers }, changes: group.flatMap(changesOf) }
}

export async function applyAdopt(scan: ScanResult, opts: AdoptOptions): Promise<ApplyResult> {
  const groups = [...byFile(scan)]
  const createdAt = (opts.now ?? (() => new Date()))()
  // `:` is not allowed in a Windows file name; the stamp still sorts as time.
  const backupDir = join(opts.dataDir, ADOPT_DIR_NAME, createdAt.toISOString().replaceAll(':', '-'))
  const outcomes: FileOutcome[] = []
  for (const [index, [file, group]] of groups.entries()) {
    outcomes.push(await adoptFile(file, group, scan, backupDir, index + 1))
  }
  const written = outcomes.flatMap((o) => (o.written === undefined ? [] : [o.written]))
  const failures = outcomes.flatMap((o) => (o.failure === undefined ? [] : [o.failure]))
  const changes = outcomes.flatMap((o) => o.changes)
  if (changes.length === 0) return { written, failures }
  await writeManifest(backupDir, manifestOf(createdAt, changes))
  return { written, failures, backupDir }
}
