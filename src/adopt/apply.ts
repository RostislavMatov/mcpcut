import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { errnoCodeOf } from '../errno.js'
import { locationsOf, type AdoptPlace, type ClientId, type ServersLocation } from './clients.js'
import { launcherOf } from './entry.js'
import {
  ensureOwnerOnlyDir,
  readConfigFile,
  linkTargetOf,
  renderLike,
  replaceFileAtomically,
  writeOwnerOnlyCopy,
  type ConfigFile,
} from './files.js'
import { ADOPT_DIR_NAME, MANIFEST_FILE_NAME, manifestOf, writeManifest, type ManifestChange } from './manifest.js'
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
  /** Files that are symlinks, to the file the write would really land on — shown in the dry run. */
  readonly linkTargets: ReadonlyMap<string, string>
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
  /** The copies could not be kept, so nothing was changed. */
  readonly copyProblem?: FileProblem
}

const CHANGED_SINCE_SCAN = 'it changed while adopt ran (the client may have rewritten it); run adopt again'

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
  const found = looked.filter((file) => files.get(file)?.kind === 'ok')
  const targets = await Promise.all(found.map(async (file) => [file, await linkTargetOf(file)] as const))
  const linkTargets = new Map(targets.flatMap(([file, target]) => (target === undefined ? [] : [[file, target] as const])))
  return { locations, problems, looked, files, linkTargets }
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
  return `could not write it (${errnoCodeOf(error) ?? String(error)}); close the client that holds it and run adopt again`
}

/** A file to write: unchanged since the scan, with its new text ready. */
interface ReadyFile {
  readonly file: string
  readonly original: string
  readonly next: string
  readonly servers: readonly string[]
  readonly changes: readonly ManifestChange[]
}

async function readyFileOf(file: string, group: readonly ScannedLocation[], scan: ScanResult): Promise<ReadyFile | FileProblem> {
  const scanned = scan.files.get(file)
  const current = await readConfigFile(file)
  if (scanned?.kind !== 'ok' || current.kind !== 'ok' || current.text !== scanned.text) return { file, reason: CHANGED_SINCE_SCAN }
  const doc = group.reduce((acc, s) => withEntries(acc, s.location.path, replacementsOf(s)), scanned.doc)
  return {
    file,
    original: scanned.text,
    next: renderLike(scanned.text, doc),
    servers: group.flatMap((s) => wrapRowsOf(s).map((row) => row.name)),
    changes: group.flatMap(changesOf),
  }
}

function isReady(value: ReadyFile | FileProblem): value is ReadyFile {
  return 'next' in value
}

/** Copies of every file and the undo record, before any file is touched. */
async function keepCopies(backupDir: string, ready: readonly ReadyFile[], createdAt: Date): Promise<void> {
  await ensureOwnerOnlyDir(backupDir)
  for (const [index, file] of ready.entries()) await writeOwnerOnlyCopy(backupDir, index + 1, file.file, file.original)
  await writeManifest(backupDir, manifestOf(createdAt, ready.flatMap((file) => file.changes)))
}

/**
 * The record was written for every ready file; when some could not be
 * written it is narrowed to the ones that were, so `--undo` does not report
 * the others as "changed since". If narrowing fails the full record stays —
 * still correct, as undo restores only entries that hold what adopt wrote.
 */
async function narrowRecord(backupDir: string, createdAt: Date, written: readonly ReadyFile[]): Promise<void> {
  try {
    if (written.length === 0) await rm(join(backupDir, MANIFEST_FILE_NAME), { force: true })
    else await writeManifest(backupDir, manifestOf(createdAt, written.flatMap((file) => file.changes)))
  } catch {
    // Safe to leave as is: see above.
  }
}

export async function applyAdopt(scan: ScanResult, opts: AdoptOptions): Promise<ApplyResult> {
  const checked = await Promise.all([...byFile(scan)].map(([file, group]) => readyFileOf(file, group, scan)))
  const stale = checked.filter((c): c is FileProblem => !isReady(c))
  const ready = checked.filter(isReady)
  if (ready.length === 0) return { written: [], failures: stale }
  const createdAt = (opts.now ?? (() => new Date()))()
  // `:` is not allowed in a Windows file name; the stamp still sorts as time.
  const backupDir = join(opts.dataDir, ADOPT_DIR_NAME, createdAt.toISOString().replaceAll(':', '-'))
  try {
    await keepCopies(backupDir, ready, createdAt)
  } catch (error) {
    return { written: [], failures: stale, copyProblem: { file: backupDir, reason: `could not keep copies there (${errnoCodeOf(error) ?? String(error)})` } }
  }
  const written: ReadyFile[] = []
  const failures: FileProblem[] = [...stale]
  for (const file of ready) {
    try {
      await replaceFileAtomically(file.file, file.next)
      written.push(file)
    } catch (error) {
      failures.push({ file: file.file, reason: writeFailureOf(error) })
    }
  }
  if (written.length < ready.length) await narrowRecord(backupDir, createdAt, written)
  const result = { written: written.map((file) => ({ file: file.file, servers: file.servers })), failures }
  return written.length === 0 ? result : { ...result, backupDir }
}
