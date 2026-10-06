import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { hasDotSegment, resolveAgentPath } from '../../src/files/paths.js'

/**
 * An agent's path is journaled as typed, and the journal's redaction may eat
 * its tail: `/p/password=1/../important.txt` acts on `/p/important.txt` but is
 * journaled as `/p/[REDACTED]`, so `files audit --path /p/important.txt` would
 * miss the call. A path with a `.` or `..` segment is refused: what is
 * journaled then names the file acted on.
 */

let root: string

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-agent-path-')))
  await mkdir(join(root, 'p'), { recursive: true })
  await writeFile(join(root, 'p', 'important.txt'), 'i')
  await writeFile(join(root, 'p', '..notes'), 'n')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('hasDotSegment', () => {
  test('a . or .. segment with either separator', () => {
    expect(hasDotSegment('/p/password=1/../important.txt')).toBe(true)
    expect(hasDotSegment('/p/./important.txt')).toBe(true)
    expect(hasDotSegment('/p/..')).toBe(true)
    expect(hasDotSegment('C:\\p\\x\\..\\y')).toBe(true)
    expect(hasDotSegment('C:/p/x/../y')).toBe(true)
  })

  test('names that only contain dots are names', () => {
    expect(hasDotSegment('/p/..notes')).toBe(false)
    expect(hasDotSegment('/p/a..b/c.')).toBe(false)
    expect(hasDotSegment('/p/.hidden')).toBe(false)
  })
})

describe('resolveAgentPath', () => {
  test('refuses a .. path in one line that says what to send instead', async () => {
    const result = await resolveAgentPath(`${root}/p/password=1/../important.txt`, [root])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal).toBe('dot-segment')
    expect(result.message).toBe('The path has a "." or ".." segment: send the full path without them — call list_roots to see your folders.')
  })

  test('the same file by its plain path resolves, and so does a name made of dots', async () => {
    expect((await resolveAgentPath(join(root, 'p', 'important.txt'), [root])).ok).toBe(true)
    expect((await resolveAgentPath(join(root, 'p', '..notes'), [root])).ok).toBe(true)
  })
})

describe('mcpcut project settings are out of an agent\'s reach', () => {
  test('a path into .mcpcut-project is refused under any spelling a volume folds', async () => {
    for (const name of ['.mcpcut-project', '.MCPCUT-PROJECT', '.mcpcut-project.', '.\uff4dcpcut-project']) {
      const result = await resolveAgentPath(join(root, 'p', name, 'policy.json'), [root])

      expect(result.ok, name).toBe(false)
      if (result.ok) continue
      expect(result.refusal).toBe('mcpcut-settings')
      expect(result.message).toBe('The path is inside .mcpcut-project, mcpcut\'s own project settings, which file tools never touch — call list_roots to see your folders.')
    }
  })

  test('a name that only starts the same is a name', async () => {
    expect((await resolveAgentPath(join(root, 'p', '.mcpcut-projects', 'x'), [root])).ok).toBe(true)
  })
})
