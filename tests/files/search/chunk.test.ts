import { describe, expect, test } from 'vitest'
import { chunkText } from '../../../src/files/search/chunk.js'
import { CHUNK_MAX_CHARS, CHUNK_MAX_PER_FILE } from '../../../src/files/search/constants.js'

describe('chunkText', () => {
  test('blank-only text has no chunks', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('  \n\t\n\r\n')).toEqual([])
  })

  test('short text is one chunk with its 1-based lines', () => {
    expect(chunkText('one\ntwo\nthree')).toEqual([{ startLine: 1, endLine: 3, body: 'one\ntwo\nthree' }])
  })

  test('packs whole lines up to the limit and overlaps one line', () => {
    const line = 'x'.repeat(400)
    const text = [line, line, line, line].join('\n')

    const chunks = chunkText(text)

    expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ])
    expect(chunks.every((chunk) => chunk.body.length <= CHUNK_MAX_CHARS)).toBe(true)
  })

  test('CRLF is read as a line break and not kept in the body', () => {
    const chunks = chunkText('a\r\nb\r\nc')

    expect(chunks).toEqual([{ startLine: 1, endLine: 3, body: 'a\nb\nc' }])
  })

  test('a 10 000-char line is split hard, with no overlap from a split line', () => {
    const chunks = chunkText(`${'y'.repeat(10_000)}\nnext`)

    expect(chunks.length).toBeGreaterThan(10)
    expect(chunks.slice(0, 10).every((chunk) => chunk.startLine === 1 && chunk.endLine === 1 && chunk.body.length === CHUNK_MAX_CHARS)).toBe(true)
    const last = chunks[chunks.length - 1]
    expect(last?.body.endsWith('next')).toBe(true)
    expect(last?.endLine).toBe(2)
    expect(chunks.map((chunk) => chunk.body.replaceAll('\n', '')).join('').replaceAll('next', '')).toBe('y'.repeat(10_000))
  })

  test('a line that follows a split line starts its own chunk without repeating the split one', () => {
    const chunks = chunkText(`${'y'.repeat(1500)}\nshort\nmore`)

    const joined = chunks.map((chunk) => chunk.body).join('|')
    expect(joined.split('short').length - 1).toBe(1)
  })

  test('every chunk stays within the limit even when an overlap line is long', () => {
    const chunks = chunkText(['a'.repeat(900), 'b'.repeat(900), 'c'.repeat(900)].join('\n'))

    expect(chunks.every((chunk) => chunk.body.length <= CHUNK_MAX_CHARS)).toBe(true)
    expect(chunks.map((chunk) => chunk.startLine)).toEqual([1, 2, 3])
  })

  test('stops at the per-file cap', () => {
    const text = Array.from({ length: CHUNK_MAX_PER_FILE * 3 }, () => 'z'.repeat(CHUNK_MAX_CHARS - 1)).join('\n')

    expect(chunkText(text)).toHaveLength(CHUNK_MAX_PER_FILE)
  })

  test('never splits a surrogate pair', () => {
    const emoji = '😀'
    const chunks = chunkText(emoji.repeat(1500))

    for (const chunk of chunks) {
      expect(chunk.body).not.toMatch(/[\uD800-\uDBFF]$/)
      expect(chunk.body).not.toMatch(/^[\uDC00-\uDFFF]/)
    }
    expect(chunks.map((chunk) => chunk.body).join('')).toBe(emoji.repeat(1500))
  })

  test('keeps Russian text intact', () => {
    expect(chunkText('Как вернуть товар?\nОтвет: в течение 14 дней.')[0]?.body).toBe('Как вернуть товар?\nОтвет: в течение 14 дней.')
  })
})
