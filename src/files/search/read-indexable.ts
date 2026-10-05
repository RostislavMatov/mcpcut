import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { O_NOFOLLOW, O_NONBLOCK } from '../io-common.js'
import { INDEX_MAX_FILE_BYTES } from './constants.js'

/**
 * Reads one file for the indexer, as safely as the catalog hashes it: opened
 * without following a symlink and without blocking on a FIFO, checked to be a
 * regular file of bounded size, and accepted only if its bytes are the ones
 * the catalog hashed (a file that changed since is indexed after the catalog
 * catches up). Binary content is skipped, never decoded leniently.
 */

export type IndexableRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'skip'; readonly reason: 'binary' | 'too large' }
  | { readonly kind: 'changed' }

const CHANGED: IndexableRead = { kind: 'changed' }
const BOM = '﻿'

function decodeText(bytes: Buffer): IndexableRead {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return { kind: 'skip', reason: 'binary' }
  }
  if (text.includes('\u0000')) return { kind: 'skip', reason: 'binary' }
  return { kind: 'text', text: text.startsWith(BOM) ? text.slice(1) : text }
}

export async function readIndexable(file: string, expectedSha256: string): Promise<IndexableRead> {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch {
    return CHANGED
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) return CHANGED
    if (info.size > INDEX_MAX_FILE_BYTES) return { kind: 'skip', reason: 'too large' }
    const bytes = await handle.readFile()
    if (bytes.length > INDEX_MAX_FILE_BYTES) return { kind: 'skip', reason: 'too large' }
    if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) return CHANGED
    return decodeText(bytes)
  } catch {
    return CHANGED
  } finally {
    await handle.close().catch(() => undefined)
  }
}
