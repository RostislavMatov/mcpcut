import { CHUNK_MAX_CHARS, CHUNK_MAX_PER_FILE } from './constants.js'

/**
 * Splits text into passages for embedding: whole lines packed up to
 * `CHUNK_MAX_CHARS`, one line of overlap between neighbours so a sentence cut
 * at a boundary appears whole in one of them. A line longer than the limit is
 * split hard (never inside a surrogate pair) and gives no overlap. Lines are
 * 1-based. Pure.
 */

export interface TextChunk {
  readonly startLine: number
  readonly endLine: number
  readonly body: string
}

interface Line {
  readonly no: number
  readonly text: string
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function hardSplit(text: string): string[] {
  const parts: string[] = []
  let from = 0
  while (from < text.length) {
    let to = Math.min(from + CHUNK_MAX_CHARS, text.length)
    if (to < text.length && isHighSurrogate(text.charCodeAt(to - 1))) to -= 1
    parts.push(text.slice(from, to))
    from = to
  }
  return parts
}

function lengthOf(lines: readonly Line[]): number {
  return lines.reduce((sum, line) => sum + line.text.length, 0) + Math.max(0, lines.length - 1)
}

function toChunk(lines: readonly Line[]): TextChunk {
  return {
    startLine: lines[0]?.no ?? 1,
    endLine: lines[lines.length - 1]?.no ?? 1,
    body: lines.map((line) => line.text).join('\n'),
  }
}

export function chunkText(text: string): TextChunk[] {
  if (text.trim() === '') return []
  const chunks: TextChunk[] = []
  let current: Line[] = []
  /** Lines of `current` that came only from the overlap: a chunk made of nothing else is not emitted. */
  let carried = 0
  const flush = (): void => {
    if (current.length > carried) chunks.push(toChunk(current))
  }
  const lines = text.split(/\r\n|\r|\n/)
  for (let index = 0; index < lines.length && chunks.length < CHUNK_MAX_PER_FILE; index += 1) {
    const line: Line = { no: index + 1, text: lines[index] ?? '' }
    if (line.text.length > CHUNK_MAX_CHARS) {
      flush()
      current = []
      carried = 0
      for (const part of hardSplit(line.text)) {
        if (chunks.length < CHUNK_MAX_PER_FILE) chunks.push(toChunk([{ no: line.no, text: part }]))
      }
      continue
    }
    if (current.length > 0 && lengthOf([...current, line]) > CHUNK_MAX_CHARS) {
      flush()
      const last = current[current.length - 1]
      // The overlap line is dropped when it would push the new line past the limit.
      current = last === undefined || lengthOf([last, line]) > CHUNK_MAX_CHARS ? [] : [last]
      carried = current.length
    }
    current = [...current, line]
  }
  if (chunks.length < CHUNK_MAX_PER_FILE) flush()
  return chunks.filter((chunk) => chunk.body.trim() !== '')
}
