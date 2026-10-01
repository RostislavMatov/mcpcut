import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { readConfigFile, renderLike, replaceFileAtomically } from '../../src/adopt/files.js'

/** A client's config written back the way the client wrote it. */

describe('renderLike', () => {
  const DOC = { a: 1, b: [2] }

  test.each([
    ['two spaces', '{\n  "x": 1\n}\n', '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n'],
    ['four spaces', '{\n    "x": 1\n}\n', '{\n    "a": 1,\n    "b": [\n        2\n    ]\n}\n'],
    ['a TAB', '{\n\t"x": 1\n}\n', '{\n\t"a": 1,\n\t"b": [\n\t\t2\n\t]\n}\n'],
    ['no final newline', '{\n  "x": 1\n}', '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}'],
    ['CRLF line endings', '{\r\n  "x": 1\r\n}\r\n', '{\r\n  "a": 1,\r\n  "b": [\r\n    2\r\n  ]\r\n}\r\n'],
    ['one line (no indent to copy): two spaces', '{"x":1}', '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}'],
    ['a byte order mark', '\uFEFF{\n  "x": 1\n}\n', '\uFEFF{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n'],
  ])('keeps %s', (_label, original, expected) => {
    expect(renderLike(original, DOC)).toBe(expected)
  })
})

describe('readConfigFile', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpcut-adopt-files-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('a file with a byte order mark parses', async () => {
    await writeFile(join(dir, 'c.json'), '\uFEFF{"mcpServers":{}}')

    expect(await readConfigFile(join(dir, 'c.json'))).toMatchObject({ kind: 'ok', doc: { mcpServers: {} } })
  })

  test('a missing file, or a folder in the way, is "missing"', async () => {
    await writeFile(join(dir, 'plain'), 'x')

    expect(await readConfigFile(join(dir, 'nope.json'))).toEqual({ kind: 'missing' })
    expect(await readConfigFile(join(dir, 'plain', 'c.json'))).toEqual({ kind: 'missing' })
  })

  describe('replaceFileAtomically', () => {
    test('a file already sitting at the temp path is neither used nor removed', async () => {
      const file = join(dir, 'c.json')
      await writeFile(file, '{}\n')
      const temp = `${file}.mcpcut-${process.pid}.tmp`
      await writeFile(temp, 'someone else')

      await expect(replaceFileAtomically(file, '{"a":1}\n')).rejects.toThrow(/EEXIST/)

      expect(await readFile(temp, 'utf8')).toBe('someone else')
      expect(await readFile(file, 'utf8')).toBe('{}\n')
    })
  })
})
