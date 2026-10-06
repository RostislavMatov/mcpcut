import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { applyRule, carveOutRule, dropRule } from '../../src/files/grant-admin.js'
import { resolveWithinRoots } from '../../src/files/paths.js'
import { isAllowed, prepareRules, type FileRule } from '../../src/files/rights.js'
import { fileRuleSchema } from '../../src/files/rule-schema.js'

/**
 * A cut-out names a folder, not a spelling of a path. Another agent (or the
 * owner) moving that folder, or putting a new one in its place, must not hand
 * its content to the agent it was cut out for: a cut-out remembers the folder
 * it was granted on, and when that folder is gone or replaced, the agent's
 * file access closes until an administrator looks.
 */

let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-carve-identity-')))
  await mkdir(join(root, 'p', 'secret'), { recursive: true })
  await writeFile(join(root, 'p', 'secret', 'key'), 'TOPSECRET')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function bRules(): Promise<readonly FileRule[]> {
  return [{ path: root, ops: ['read', 'write', 'edit', 'delete'] }, await carveOutRule(join(root, 'p', 'secret'))]
}

async function canRead(rules: readonly FileRule[], target: string): Promise<boolean | 'closed'> {
  const prepared = await prepareRules(rules)
  if (!prepared.ok) return 'closed'
  const resolved = await resolveWithinRoots(target, [root])
  return resolved.ok && isAllowed(resolved.path, 'read', prepared.rules)
}

describe('a cut-out remembers its folder', () => {
  test('a cut-out on an existing folder stores its identity; the schema takes it', async () => {
    const rule = await carveOutRule(join(root, 'p', 'secret'))

    expect(rule.identity).toEqual({ dev: expect.stringMatching(/^\d+$/), ino: expect.stringMatching(/^\d+$/) })
    expect(fileRuleSchema.parse(rule)).toEqual(rule)
  })

  test('in place, the cut-out refuses and the rest is readable', async () => {
    const rules = await bRules()
    await writeFile(join(root, 'p', 'open.txt'), 'o')

    expect(await canRead(rules, join(root, 'p', 'secret', 'key'))).toBe(false)
    expect(await canRead(rules, join(root, 'p', 'open.txt'))).toBe(true)
  })

  test('moved away by someone else: access closes instead of following the old path', async () => {
    const rules = await bRules()
    await rename(join(root, 'p'), join(root, 'q'))

    expect(await canRead(rules, join(root, 'q', 'secret', 'key'))).toBe('closed')
  })

  test('replaced by a new folder of the same name: access closes', async () => {
    const rules = await bRules()
    await rename(join(root, 'p', 'secret'), join(root, 'p', 'moved'))
    await mkdir(join(root, 'p', 'secret'))

    const prepared = await prepareRules(rules)
    expect(prepared.ok).toBe(false)
    if (prepared.ok) return
    expect(prepared.message).toBe(
      `File access is closed: the cut-out folder ${join(root, 'p', 'secret')} was moved, deleted or replaced. An administrator checks it and runs \`mcpcut files revoke\` or \`mcpcut files grant\` again.`,
    )
  })

  test('a cut-out granted before its folder exists, and an old rule without identity, work as before', async () => {
    const ahead = await carveOutRule(join(root, 'p', 'later'))
    const old: FileRule = { path: join(root, 'p', 'secret'), ops: [] }

    expect(ahead.identity).toBeUndefined()
    expect(await canRead([{ path: root, ops: ['read'] }, ahead, old], join(root, 'p', 'secret', 'key'))).toBe(false)
  })

  test('applyRule and dropRule keep the identity of the rules they do not touch', async () => {
    const carve = await carveOutRule(join(root, 'p', 'secret'))
    const first = applyRule({}, carve)
    if (!first.ok) throw new Error(first.message)
    const second = applyRule(first.grants, { path: root, ops: ['read'] })
    if (!second.ok) throw new Error(second.message)
    const dropped = dropRule(second.grants, [root])

    expect(second.grants['files']?.paths).toContainEqual(carve)
    expect(dropped.grants['files']?.paths).toEqual([carve])
  })
})
