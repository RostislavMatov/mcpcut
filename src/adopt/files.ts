import { chmod, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { errnoCodeOf } from '../errno.js'
import { syncDir } from '../sync-dir.js'

/**
 * File IO for `mcpcut adopt` (P3): read a client's JSON config, write it back
 * the way the client wrote it, and keep owner-only copies. A client's config
 * is the user's own file — a half-written one would lose every server in it —
 * so a write is temp file, fsync, rename, and the rename lands on the real
 * file behind a symlink (dotfile managers link these files).
 */

export type ConfigFile =
  | { readonly kind: 'missing' }
  | { readonly kind: 'problem'; readonly reason: string }
  | { readonly kind: 'ok'; readonly text: string; readonly doc: unknown }

const OWNER_ONLY_FILE = 0o600
const OWNER_ONLY_DIR = 0o700
const PERMISSION_BITS = 0o777
const DEFAULT_INDENT = 2
/** The whitespace before the first indented key: two spaces, four, or a TAB. */
const INDENT_PATTERN = /\n([ \t]+)"/
const BYTE_ORDER_MARK = '﻿'
const CRLF = '\r\n'
const ABSENT_CODES: readonly string[] = ['ENOENT', 'ENOTDIR']

function withoutBom(text: string): string {
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text
}

export async function readConfigFile(file: string): Promise<ConfigFile> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    const code = errnoCodeOf(error)
    if (code !== undefined && ABSENT_CODES.includes(code)) return { kind: 'missing' }
    return { kind: 'problem', reason: `could not read it (${code ?? String(error)})` }
  }
  try {
    return { kind: 'ok', text, doc: JSON.parse(withoutBom(text)) }
  } catch {
    return { kind: 'problem', reason: 'not valid JSON (a comment or a trailing comma?)' }
  }
}

/** `doc` serialised the way `original` was: same indent, line endings, BOM and final newline. */
export function renderLike(original: string, doc: unknown): string {
  const indent = INDENT_PATTERN.exec(original)?.[1] ?? DEFAULT_INDENT
  const finalNewline = /\r?\n$/.test(original) ? '\n' : ''
  const json = `${JSON.stringify(doc, null, indent)}${finalNewline}`
  const lines = original.includes(CRLF) ? json.replaceAll('\n', CRLF) : json
  return original.startsWith(BYTE_ORDER_MARK) ? `${BYTE_ORDER_MARK}${lines}` : lines
}

/** Replaces `file` (or the file its symlink points at) in one rename, keeping its permission bits. */
export async function replaceFileAtomically(file: string, content: string): Promise<void> {
  const target = await realpath(file)
  const mode = (await stat(target)).mode & PERMISSION_BITS
  const temp = `${target}.mcpcut-${process.pid}.tmp`
  try {
    const handle = await open(temp, 'wx', mode)
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    // The umask may have narrowed `mode` at creation; the file keeps exactly what it had.
    await chmod(temp, mode)
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  await syncDir(dirname(target))
}

export async function ensureOwnerOnlyDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: OWNER_ONLY_DIR })
}

/** A copy of `text` as `<index>-<file name>` in `dir`, readable by the owner only (it may hold env secrets). */
export async function writeOwnerOnlyCopy(dir: string, index: number, file: string, text: string): Promise<string> {
  const copy = join(dir, `${index}-${basename(file)}`)
  await writeFile(copy, text, { mode: OWNER_ONLY_FILE, flag: 'wx' })
  return copy
}

export async function writeOwnerOnlyFile(file: string, text: string): Promise<void> {
  await writeFile(file, text, { mode: OWNER_ONLY_FILE })
}
