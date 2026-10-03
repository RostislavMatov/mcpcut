import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { canonicalRules, isAllowed, opsAt, type FileRule } from '../../src/files/rights.js'

/**
 * ADR-0020 §2: an agent's file rights are rules `{ path, ops }`. A rule on a
 * folder covers everything inside it; the deepest rule that contains the
 * target decides, so a deeper rule can narrow (an empty `ops` cuts a subfolder
 * out) or widen. Two rules on the same folder — the agent's own and a group's
 * — add up.
 */

const data = resolve('/data')
const a = join(data, 'a')

describe('opsAt', () => {
  test('no rules — no operations', () => {
    expect(opsAt(join(a, 'x.txt'), [])).toEqual([])
  })

  test('a rule on a folder covers the folder, its files and everything deeper', () => {
    const rules: readonly FileRule[] = [{ path: a, ops: ['read'] }]
    expect(opsAt(a, rules)).toEqual(['read'])
    expect(opsAt(join(a, 'x.txt'), rules)).toEqual(['read'])
    expect(opsAt(join(a, 'deep', 'er', 'y.md'), rules)).toEqual(['read'])
  })

  test('a sibling whose name starts with the folder name is not covered', () => {
    expect(opsAt(join(data, 'ab', 'x.txt'), [{ path: a, ops: ['read'] }])).toEqual([])
  })

  test('a parent of the rule is not covered', () => {
    expect(opsAt(data, [{ path: a, ops: ['read'] }])).toEqual([])
  })

  test('a deeper rule with no operations cuts a subfolder out', () => {
    const rules: readonly FileRule[] = [
      { path: a, ops: ['read', 'write'] },
      { path: join(a, 'secret'), ops: [] },
    ]
    expect(opsAt(join(a, 'secret', 'keys.txt'), rules)).toEqual([])
    expect(opsAt(join(a, 'notes.txt'), rules)).toEqual(['read', 'write'])
  })

  test('a deeper rule can widen as well as narrow', () => {
    const rules: readonly FileRule[] = [
      { path: a, ops: ['read'] },
      { path: join(a, 'drafts'), ops: ['read', 'write', 'edit'] },
    ]
    expect(opsAt(join(a, 'drafts', 'plan.md'), rules)).toEqual(['read', 'write', 'edit'])
    expect(opsAt(join(a, 'plan.md'), rules)).toEqual(['read'])
  })

  test('rules on the same folder add up, in a fixed order and without repeats', () => {
    const rules: readonly FileRule[] = [
      { path: a, ops: ['delete', 'read'] },
      { path: a, ops: ['read', 'edit'] },
    ]
    expect(opsAt(join(a, 'x.txt'), rules)).toEqual(['read', 'edit', 'delete'])
  })

  test('isAllowed answers for one operation', () => {
    const rules: readonly FileRule[] = [{ path: a, ops: ['read'] }]
    expect(isAllowed(join(a, 'x.txt'), 'read', rules)).toBe(true)
    expect(isAllowed(join(a, 'x.txt'), 'delete', rules)).toBe(false)
  })
})

describe('canonicalRules', () => {
  let base: string

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-files-rights-')))
    await mkdir(join(base, 'real', 'docs'), { recursive: true })
    await symlink(join(base, 'real'), join(base, 'alias'))
    await symlink(join(base, 'nowhere'), join(base, 'dangling'))
  })

  afterAll(async () => {
    await rm(base, { recursive: true, force: true })
  })

  test('a rule named through a symlink is compared on its canonical path', async () => {
    const [rule] = await canonicalRules([{ path: join(base, 'alias', 'docs'), ops: ['read'] }])
    expect(rule?.path).toBe(join(base, 'real', 'docs'))
  })

  test('a rule on a folder that does not exist yet resolves through its nearest existing parent', async () => {
    const [rule] = await canonicalRules([{ path: join(base, 'alias', 'later'), ops: ['write'] }])
    expect(rule?.path).toBe(join(base, 'real', 'later'))
  })

  test('a rule that cannot be resolved is kept as written, so a cut-out never silently disappears', async () => {
    const rules = await canonicalRules([{ path: join(base, 'dangling', 'x'), ops: [] }])
    expect(rules).toEqual([{ path: join(base, 'dangling', 'x'), ops: [] }])
  })
})
