import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import path from 'node:path'

/**
 * Network and FUSE volumes are refused, not trusted. Folders are told apart
 * by identity (`identity.ts`), and a network file system may make that identity
 * up: macOS `smbfs` reports a different inode for each Unicode spelling of a
 * name (NFC `café` and NFD `café` open one folder under two inodes) and a new
 * inode after a rename. A carved-out folder there is reachable through its
 * other spelling, so nothing on such a volume reaches an agent.
 */

export type VolumeKind = { readonly kind: 'local' } | { readonly kind: 'network'; readonly fsType: string }

export interface DarwinMount {
  readonly mountPoint: string
  readonly fsType: string
  readonly isLocal: boolean
}

export interface VolumeDeps {
  readonly platform: NodeJS.Platform
  /** `statfs().type` of an existing folder; `null` when it cannot be read. */
  readonly statfsType: (folder: string) => Promise<number | null>
  readonly darwinMounts: () => Promise<readonly DarwinMount[]>
}

/** Linux `statfs` magic numbers of network and FUSE file systems. */
const NETWORK_MAGICS: ReadonlyMap<number, string> = new Map([
  [0x6969, 'nfs'],
  [0x517b, 'smb'],
  [0xff534d42, 'cifs'],
  [0xfe534d42, 'smb2'],
  [0x65735546, 'fuse'],
  [0x01021997, 'v9fs'],
  [0x5346414f, 'afs'],
  [0x6b414653, 'afs'],
  [0x73757245, 'coda'],
  [0x00c36400, 'ceph'],
  [0x47504653, 'gpfs'],
  [0x0bd00bd0, 'lustre'],
])

const UNKNOWN: VolumeKind = { kind: 'network', fsType: 'unknown' }
const MOUNT_TABLE_TTL_MS = 2_000
const MOUNT_TIMEOUT_MS = 5_000

export function isNetworkStatfsType(type: number): boolean {
  return NETWORK_MAGICS.has(type >>> 0)
}

/** `\\server\share\…` (or with forward slashes): what a mapped network drive resolves to. */
export function isUncPath(value: string): boolean {
  return /^[\\/]{2}[^\\/?.]/.test(value)
}

/** The lines of macOS `mount`: `<device> on <mount point> (<type>, <flags…>)`; a mount point may hold spaces. */
export function parseDarwinMounts(output: string): readonly DarwinMount[] {
  return output.split('\n').flatMap((line) => {
    const match = /^.+? on (\/.*) \(([^()]*)\)$/.exec(line.trim())
    if (match === null) return []
    const flags = (match[2] ?? '').split(',').map((flag) => flag.trim())
    return [{ mountPoint: match[1] ?? '', fsType: flags[0] ?? '', isLocal: flags.includes('local') }]
  })
}

function holds(mountPoint: string, target: string): boolean {
  if (mountPoint === '/') return true
  return target === mountPoint || target.startsWith(`${mountPoint}/`)
}

/** The deepest mount point holding `target` decides: a volume without the `local` flag is not trusted. */
export function darwinVolumeOf(target: string, mounts: readonly DarwinMount[]): VolumeKind {
  const deepest = mounts
    .filter((mount) => holds(mount.mountPoint, target))
    .reduce<DarwinMount | undefined>((best, mount) => (best === undefined || mount.mountPoint.length > best.mountPoint.length ? mount : best), undefined)
  if (deepest === undefined) return UNKNOWN
  return deepest.isLocal ? { kind: 'local' } : { kind: 'network', fsType: deepest.fsType || 'unknown' }
}

/** The volume of a canonical path (or of its nearest existing folder, which the caller passes). */
export async function volumeKindOf(canonical: string, deps: VolumeDeps = defaultVolumeDeps()): Promise<VolumeKind> {
  if (deps.platform === 'win32') return isUncPath(canonical) ? { kind: 'network', fsType: 'smb' } : { kind: 'local' }
  if (deps.platform === 'darwin') return darwinVolumeOf(canonical, await deps.darwinMounts())
  const type = await deps.statfsType(canonical)
  if (type === null) return UNKNOWN
  return isNetworkStatfsType(type) ? { kind: 'network', fsType: NETWORK_MAGICS.get(type >>> 0) ?? 'unknown' } : { kind: 'local' }
}

/** The nearest existing folder of a canonical path that may not exist yet. */
async function statfsTypeOf(target: string): Promise<number | null> {
  for (let current = target; ; current = path.dirname(current)) {
    try {
      return (await statfs(current)).type
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || path.dirname(current) === current) return null
    }
  }
}

let mountTable: { readonly at: number; readonly mounts: Promise<readonly DarwinMount[]> } | null = null

/** `/sbin/mount`, read at most once per two seconds; a failure gives no table, and nothing is trusted. */
function readDarwinMounts(): Promise<readonly DarwinMount[]> {
  const now = Date.now()
  if (mountTable !== null && now - mountTable.at < MOUNT_TABLE_TTL_MS) return mountTable.mounts
  const mounts = new Promise<readonly DarwinMount[]>((resolve) => {
    execFile('/sbin/mount', [], { timeout: MOUNT_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => {
      resolve(error === null ? parseDarwinMounts(stdout) : [])
    })
  })
  mountTable = { at: now, mounts }
  return mounts
}

export function defaultVolumeDeps(): VolumeDeps {
  return { platform: process.platform, statfsType: statfsTypeOf, darwinMounts: readDarwinMounts }
}

/** The one line a refusal prints. */
export function networkVolumeMessage(folder: string, fsType: string): string {
  return `${folder} is on a network or FUSE drive (${fsType}), where mcpcut cannot tell folders apart reliably: choose a folder on a local disk`
}
