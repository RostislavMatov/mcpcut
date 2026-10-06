import { describe, expect, test } from 'vitest'
import {
  darwinVolumeOf,
  isNetworkStatfsType,
  isUncPath,
  parseDarwinMounts,
  volumeKindOf,
  type VolumeDeps,
} from '../../src/files/volume.js'

const DARWIN_MOUNTS = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  'devfs on /dev (devfs, local, nobrowse)',
  '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
  'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
  '//smoke@127.0.0.1:1445/data on /private/tmp/smb/mnt (smbfs, nodev, nosuid, mounted by me)',
  '//me@nas/My Share on /Volumes/My Share (smbfs, nodev, nosuid, mounted by me)',
  '/dev/disk5s1 on /Volumes/Stick (msdos, local, nodev, nosuid, noowners)',
].join('\n')

describe('parseDarwinMounts', () => {
  test('reads mount points and whether each is local, spaces in names included', () => {
    const mounts = parseDarwinMounts(DARWIN_MOUNTS)

    expect(mounts).toContainEqual({ mountPoint: '/', fsType: 'apfs', isLocal: true })
    expect(mounts).toContainEqual({ mountPoint: '/private/tmp/smb/mnt', fsType: 'smbfs', isLocal: false })
    expect(mounts).toContainEqual({ mountPoint: '/Volumes/My Share', fsType: 'smbfs', isLocal: false })
    expect(mounts).toContainEqual({ mountPoint: '/System/Volumes/Data/home', fsType: 'autofs', isLocal: false })
  })

  test('skips lines it cannot read', () => {
    expect(parseDarwinMounts('garbage\n\n')).toEqual([])
  })
})

describe('darwinVolumeOf', () => {
  const mounts = parseDarwinMounts(DARWIN_MOUNTS)

  test('the deepest mount point holding the path decides', () => {
    expect(darwinVolumeOf('/private/tmp/smb/mnt/project/x.txt', mounts)).toEqual({ kind: 'network', fsType: 'smbfs' })
    expect(darwinVolumeOf('/private/tmp/smb/mnt', mounts)).toEqual({ kind: 'network', fsType: 'smbfs' })
    expect(darwinVolumeOf('/private/tmp/smb/mntx/a', mounts)).toEqual({ kind: 'local' })
    expect(darwinVolumeOf('/Volumes/My Share/docs', mounts)).toEqual({ kind: 'network', fsType: 'smbfs' })
    expect(darwinVolumeOf('/Volumes/Stick/a', mounts)).toEqual({ kind: 'local' })
    expect(darwinVolumeOf('/Users/me/work', mounts)).toEqual({ kind: 'local' })
  })

  test('no mount table at all is not trusted', () => {
    expect(darwinVolumeOf('/Users/me/work', [])).toEqual({ kind: 'network', fsType: 'unknown' })
  })
})

describe('isNetworkStatfsType', () => {
  test('NFS, SMB, CIFS, SMB2 and FUSE are network (or cannot be trusted); ext4, xfs, btrfs, tmpfs, overlay are not', () => {
    for (const magic of [0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x65735546, 0x01021997]) expect(isNetworkStatfsType(magic)).toBe(true)
    for (const magic of [0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630]) expect(isNetworkStatfsType(magic)).toBe(false)
  })

  test('a magic read back as a negative 32-bit number still matches', () => {
    expect(isNetworkStatfsType(0xff534d42 | 0)).toBe(true)
  })
})

describe('isUncPath', () => {
  test('a share path is UNC; a drive path is not', () => {
    expect(isUncPath('\\\\nas\\share\\docs')).toBe(true)
    expect(isUncPath('//nas/share/docs')).toBe(true)
    expect(isUncPath('C:\\Users\\me')).toBe(false)
  })
})

describe('volumeKindOf', () => {
  const deps = (over: Partial<VolumeDeps>): VolumeDeps => ({
    platform: 'linux',
    statfsType: async () => 0xef53,
    darwinMounts: async () => [],
    ...over,
  })

  test('Linux asks statfs of the nearest existing folder', async () => {
    expect(await volumeKindOf('/mnt/nfs/a', deps({ statfsType: async () => 0x6969 }))).toEqual({ kind: 'network', fsType: 'nfs' })
    expect(await volumeKindOf('/home/me/a', deps({}))).toEqual({ kind: 'local' })
  })

  test('Linux: a statfs that fails is not trusted', async () => {
    expect(await volumeKindOf('/x', deps({ statfsType: async () => null }))).toEqual({ kind: 'network', fsType: 'unknown' })
  })

  test('Windows: a canonical UNC path is a network share (mapped drives resolve to one)', async () => {
    expect(await volumeKindOf('\\\\nas\\share\\a', deps({ platform: 'win32' }))).toEqual({ kind: 'network', fsType: 'smb' })
    expect(await volumeKindOf('C:\\work\\a', deps({ platform: 'win32' }))).toEqual({ kind: 'local' })
  })

  test('macOS reads the mount table', async () => {
    const darwin = deps({ platform: 'darwin', darwinMounts: async () => parseDarwinMounts(DARWIN_MOUNTS) })
    expect(await volumeKindOf('/private/tmp/smb/mnt/p', darwin)).toEqual({ kind: 'network', fsType: 'smbfs' })
    expect(await volumeKindOf('/Users/me/p', darwin)).toEqual({ kind: 'local' })
  })
})
