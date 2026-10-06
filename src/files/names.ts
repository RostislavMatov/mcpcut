import path from 'node:path'
import { TRASH_DIR_NAME } from './constants.js'

/**
 * Name-level checks of the file module (ADR-0020 §3) — pure, no file system:
 * names Windows cannot hold safely, device paths, the trash name in any
 * spelling, and the lexical gate that keeps the resolver from touching a path
 * that is nowhere near a root.
 */

export type NameRefusal = 'reserved-name' | 'device-path'

/**
 * CON, PRN, AUX, NUL, COM1–9, LPT1–9 (and the superscript digits), CONIN$,
 * CONOUT$, CLOCK$ — with or without an extension, spaces before it included
 * (`NUL .txt` still opens the device).
 */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$) *(\..*)?$/i

const TRAILING_DOT_OR_SPACE = /[. ]$/

/** `\\.\` (devices, pipes) and `\\?\` (extended paths that skip normalization), either slash. */
const WINDOWS_DEVICE_PREFIX = /^[\\/]{2}[.?][\\/]/

/** Case and normalization folding only where the volumes usually ignore both. */
const FOLDING_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['darwin', 'win32'])

export function pathModuleOf(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/**
 * Names Windows cannot hold safely: a device or extended path, an alternate
 * data stream (`file:stream`), a reserved device name, or a segment ending in
 * a dot or space (Windows trims those, so two names would reach one file).
 * Ordinary on POSIX.
 */
export function checkName(raw: string, platform: NodeJS.Platform = process.platform): NameRefusal | null {
  if (platform !== 'win32') return null
  if (WINDOWS_DEVICE_PREFIX.test(raw)) return 'device-path'
  const rest = raw.slice(path.win32.parse(raw).root.length)
  if (rest.includes(':')) return 'reserved-name'
  const segments = rest.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
  const isReserved = (segment: string): boolean =>
    WINDOWS_RESERVED_NAME.test(segment) || TRAILING_DOT_OR_SPACE.test(segment)
  return segments.some(isReserved) ? 'reserved-name' : null
}

/**
 * A segment as a case-insensitive, normalization-insensitive volume — or a
 * server behind a share — may see it: NFKC (`ſ` is `s`), case folded both
 * ways, trailing dots and spaces dropped.
 */
export function foldName(segment: string): string {
  return segment.normalize('NFKC').toUpperCase().toLowerCase().replace(/[. ]+$/, '')
}

/** Any segment that some volume could take for `name` (given folded). */
export function hasSegmentFolded(value: string, name: string): boolean {
  return value.split(/[\\/]/).some((segment) => segment !== '' && foldName(segment) === name)
}

/** Any segment that some volume could take for the trash folder. */
export function hasTrashSegment(relative: string): boolean {
  return hasSegmentFolded(relative, TRASH_DIR_NAME)
}

/** The comparison key for lexical checks: folded where the platform's volumes usually fold. */
export function lexicalKey(value: string, platform: NodeJS.Platform = process.platform): string {
  return FOLDING_PLATFORMS.has(platform) ? value.normalize('NFC').toLowerCase() : value
}

/** Segment-wise containment of one path in another; never a string prefix. */
export function isWithinOn(root: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = pathModuleOf(platform)
  const relative = paths.relative(root, target)
  if (relative === '') return true
  return relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)
}

/**
 * The gate before any file system call on an agent-named path: it must lie,
 * as written, under one of the root spellings (as declared, as canonical).
 * Loose on purpose — folded where volumes fold — because the decision is made
 * later on file identities; its job is that `\\attacker\share\x` or a path in
 * a stranger's folder is refused without being opened (a UNC path would make
 * Windows connect and offer credentials).
 */
export function isLexicallyUnder(
  target: string,
  rootSpellings: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const key = lexicalKey(target, platform)
  return rootSpellings.some((root) => isWithinOn(lexicalKey(root, platform), key, platform))
}

/** Path segments of an absolute path, for depth comparisons that string length would get wrong. */
export function segmentCount(value: string): number {
  return value.split(/[\\/]/).filter((segment) => segment !== '').length
}
