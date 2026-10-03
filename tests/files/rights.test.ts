import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { resolveWithinRoots, type ResolvedPath } from '../../src/files/paths.js'
import { isAllowed, opsAt, prepareRules, type FileRule, type PreparedRule } from '../../src/files/rights.js'

/**
 * ADR-0020 §2: an agent's file rights are rules `{ path, ops }`. A rule on a
 * folder covers everything inside it; the deepest rule that contains the
 * target decides, so a deeper rule can narrow (an empty `ops` cuts a subfolder
 * out) or widen; rules on the same folder add up, and an empty one wins the
 * tie. Rules are matched on file identities (review 03.10): a spelling of the
 * path cannot slip past a cut-out, and a rule folder swapped for a symlink or
 * that cannot be resolved closes all file access instead of vanishing.
 */

let base: string
let root: string

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-files-rights-')))
  root = join(base, 'r')
  await mkdir(join(root, 'a', 'secret'), { recursive: true })
  await mkdir(join(root, 'a', 'drafts'), { recursive: true })
  await mkdir(join(root, 'ab'), { recursive: true })
  await writeFile(join(root, 'a', 'x.txt'), 'x')
  await writeFile(join(root, 'a', 'secret', 'keys.txt'), 'k')
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

async function target(...segments: string[]): Promise<ResolvedPath> {
  const result = await resolveWithinRoots(join(root, ...segments), [root])
  if (!result.ok) throw new Error(`${result.refusal}: ${result.message}`)
  return result.path
}

async function prepared(rules: readonly FileRule[]): Promise<readonly PreparedRule[]> {
  const result = await prepareRules(rules)
  if (!result.ok) throw new Error(result.message)
  return result.rules
}

describe('opsAt', () => {
  test('no rules — no operations', async () => {
    expect(opsAt(await target('a', 'x.txt'), [])).toEqual([])
  })

  test('a rule on a folder covers the folder, its files and new files deeper down', async () => {
    const rules = await prepared([{ path: join(root, 'a'), ops: ['read'] }])
    expect(opsAt(await target('a'), rules)).toEqual(['read'])
    expect(opsAt(await target('a', 'x.txt'), rules)).toEqual(['read'])
    expect(opsAt(await target('a', 'new', 'deep.md'), rules)).toEqual(['read'])
  })

  test('a sibling whose name starts with the folder name is not covered, nor is the parent', async () => {
    const rules = await prepared([{ path: join(root, 'a'), ops: ['read'] }])
    expect(opsAt(await target('ab'), rules)).toEqual([])
    expect(opsAt(await target(), rules)).toEqual([])
  })

  test('a deeper rule with no operations cuts a subfolder out; a deeper rule can also widen', async () => {
    const rules = await prepared([
      { path: join(root, 'a'), ops: ['read', 'write'] },
      { path: join(root, 'a', 'secret'), ops: [] },
      { path: join(root, 'a', 'drafts'), ops: ['read', 'write', 'edit'] },
    ])
    expect(opsAt(await target('a', 'secret', 'keys.txt'), rules)).toEqual([])
    expect(opsAt(await target('a', 'drafts', 'plan.md'), rules)).toEqual(['read', 'write', 'edit'])
    expect(opsAt(await target('a', 'x.txt'), rules)).toEqual(['read', 'write'])
  })

  test('rules on the same folder add up, in a fixed order', async () => {
    const rules = await prepared([
      { path: join(root, 'a'), ops: ['delete', 'read'] },
      { path: join(root, 'a'), ops: ['read', 'edit'] },
    ])
    expect(opsAt(await target('a', 'x.txt'), rules)).toEqual(['read', 'edit', 'delete'])
  })

  test("an empty rule wins a tie — one group's cut-out is not undone by another group's grant", async () => {
    const rules = await prepared([
      { path: join(root, 'a', 'secret'), ops: [] },
      { path: join(root, 'a', 'secret'), ops: ['read'] },
    ])
    expect(opsAt(await target('a', 'secret', 'keys.txt'), rules)).toEqual([])
  })

  test('a cut-out on a folder that does not exist yet still holds when the agent creates it', async () => {
    const rules = await prepared([
      { path: join(root, 'a'), ops: ['read', 'write'] },
      { path: join(root, 'a', 'later'), ops: [] },
    ])
    expect(opsAt(await target('a', 'later', 'x.txt'), rules)).toEqual([])
  })

  test.runIf(process.platform === 'darwin')('an NFD spelling cannot slip past a cut-out on an NFC folder', async () => {
    await mkdir(join(root, 'a', 'café'), { recursive: true })
    const rules = await prepared([
      { path: join(root, 'a'), ops: ['read', 'write'] },
      { path: join(root, 'a', 'café'), ops: [] },
    ])
    expect(opsAt(await target('a', 'café', 'x.txt'), rules)).toEqual([])
  })

  test.runIf(process.platform === 'darwin' || process.platform === 'win32')(
    'another letter case cannot slip past a cut-out',
    async () => {
      const rules = await prepared([
        { path: join(root, 'a'), ops: ['read', 'write'] },
        { path: join(root, 'a', 'secret'), ops: [] },
      ])
      expect(opsAt(await target('A', 'SECRET', 'keys.txt'), rules)).toEqual([])
    },
  )

  test('isAllowed answers for one operation', async () => {
    const rules = await prepared([{ path: join(root, 'a'), ops: ['read'] }])
    expect(isAllowed(await target('a', 'x.txt'), 'read', rules)).toBe(true)
    expect(isAllowed(await target('a', 'x.txt'), 'delete', rules)).toBe(false)
  })
})

describe('prepareRules — fail closed', () => {
  test('a rule folder replaced by a symlink closes all file access instead of following it', async () => {
    await mkdir(join(root, 'pub'), { recursive: true })
    await rename(join(root, 'pub'), join(root, 'pub-old'))
    await symlink(join(root, 'a', 'secret'), join(root, 'pub'))
    const result = await prepareRules([
      { path: join(root, 'pub'), ops: ['write'] },
      { path: join(root, 'a', 'secret'), ops: [] },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.problem).toBe('rule-changed')
      expect(result.message).toContain('mcpcut files grant')
    }
  })

  test('a rule that cannot be resolved (a link loop) closes all file access', async () => {
    await symlink(join(root, 'loop-b'), join(root, 'loop-a'))
    await symlink(join(root, 'loop-a'), join(root, 'loop-b'))
    const result = await prepareRules([{ path: join(root, 'loop-a', 'x'), ops: [] }])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problem).toBe('rule-unresolvable')
  })
})
