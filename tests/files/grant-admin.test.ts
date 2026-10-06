import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { AgentGrant } from '../../src/agents/schema.js'
import { MAX_PATHS_PER_GRANT } from '../../src/files/constants.js'
import { grantPath, revokePath } from '../../src/files/grant-admin.js'

let base: string
let root: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-grant-admin-')))
  root = join(base, 'root')
  await mkdir(join(root, 'a', 'secret'), { recursive: true })
  await mkdir(join(root, 'b'), { recursive: true })
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

function filesOf(grants: Readonly<Record<string, AgentGrant>>): AgentGrant | undefined {
  return grants['files']
}

describe('grantPath', () => {
  test('creates a files grant with tools * and the rule when the agent has none', async () => {
    const result = await grantPath({}, [root], join(root, 'a'), ['read'])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(filesOf(result.grants)).toEqual({ tools: '*', paths: [{ path: join(root, 'a'), ops: ['read'] }] })
    expect(result.rule).toEqual({ path: join(root, 'a'), ops: ['read'] })
  })

  test('stores the canonical path even when given through a symlinked ancestor', async () => {
    const link = join(base, 'link')
    await symlink(root, link)

    const result = await grantPath({}, [root], join(link, 'a'), ['read'])

    expect(result.ok && result.rule.path).toBe(join(root, 'a'))
  })

  test('replaces a rule with the same path instead of appending', async () => {
    const first = await grantPath({}, [root], join(root, 'a'), ['read'])
    if (!first.ok) throw new Error('setup')

    const second = await grantPath(first.grants, [root], join(root, 'a'), ['read', 'write'])

    expect(second.ok && filesOf(second.grants)?.paths).toEqual([{ path: join(root, 'a'), ops: ['read', 'write'] }])
  })

  test('appends a different path and keeps the rules sorted by path', async () => {
    const first = await grantPath({}, [root], join(root, 'b'), ['read'])
    if (!first.ok) throw new Error('setup')

    const second = await grantPath(first.grants, [root], join(root, 'a'), ['edit'])

    expect(second.ok && filesOf(second.grants)?.paths?.map((rule) => rule.path)).toEqual([join(root, 'a'), join(root, 'b')])
  })

  test('none gives an empty ops list (a cut-out) that remembers its folder', async () => {
    const result = await grantPath({}, [root], join(root, 'a', 'secret'), [])

    expect(result.ok && filesOf(result.grants)?.paths).toEqual([
      { path: join(root, 'a', 'secret'), ops: [], identity: { dev: expect.any(String), ino: expect.any(String) } },
    ])
  })

  test('orders and dedupes ops in the canonical order', async () => {
    const result = await grantPath({}, [root], join(root, 'a'), ['delete', 'read', 'read'])

    expect(result.ok && result.rule.ops).toEqual(['read', 'delete'])
  })

  test('keeps the other fields of an existing files grant and other servers', async () => {
    const grants: Record<string, AgentGrant> = {
      files: { tools: ['read_file'], resources: '*' },
      github: { tools: '*' },
    }

    const result = await grantPath(grants, [root], join(root, 'a'), ['read'])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(filesOf(result.grants)).toEqual({
      tools: ['read_file'],
      resources: '*',
      paths: [{ path: join(root, 'a'), ops: ['read'] }],
    })
    expect(result.grants['github']).toEqual({ tools: '*' })
  })

  test('refuses a path outside the roots and names the roots and the way to add one', async () => {
    const result = await grantPath({}, [root], join(base, 'elsewhere'), ['read'])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain(root)
    expect(result.message).toContain('mcpcut files root add')
    expect(result.message).not.toContain('\n')
  })

  test('with no roots at all the refusal says how to declare the first one', async () => {
    const result = await grantPath({}, [], join(root, 'a'), ['read'])

    expect(!result.ok && result.message).toMatch(/no roots.*mcpcut files root add/)
  })

  test('refuses a relative path', async () => {
    const result = await grantPath({}, [root], 'a/b', ['read'])

    expect(!result.ok && result.message).toMatch(/absolute/)
  })

  test('refuses a path inside the trash', async () => {
    await mkdir(join(root, '.mcpcut-trash'))

    const result = await grantPath({}, [root], join(root, '.mcpcut-trash'), ['read'])

    expect(!result.ok && result.message).toMatch(/trash/)
  })

  test('refuses past MAX_PATHS_PER_GRANT', async () => {
    const paths = Array.from({ length: MAX_PATHS_PER_GRANT }, (_, index) => ({ path: join(root, `x${index}`), ops: [] }))

    const result = await grantPath({ files: { tools: '*', paths } }, [root], join(root, 'a'), ['read'])

    expect(!result.ok && result.message).toMatch(new RegExp(`at most ${MAX_PATHS_PER_GRANT}`))
  })

  test('replacing a rule at the limit is allowed', async () => {
    const paths = Array.from({ length: MAX_PATHS_PER_GRANT - 1 }, (_, index) => ({ path: join(root, `x${index}`), ops: [] }))
    const full = { files: { tools: '*' as const, paths: [...paths, { path: join(root, 'a'), ops: [] }] } }

    const result = await grantPath(full, [root], join(root, 'a'), ['read'])

    expect(result.ok).toBe(true)
  })

  test('never mutates its inputs', async () => {
    const grants: Record<string, AgentGrant> = deepFreeze({ files: { tools: '*', paths: [{ path: join(root, 'b'), ops: ['read'] }] } })

    const result = await grantPath(grants, [root], join(root, 'a'), ['read'])

    expect(result.ok).toBe(true)
    expect(grants['files']?.paths).toHaveLength(1)
  })
})

describe('revokePath', () => {
  async function withRules(): Promise<Record<string, AgentGrant>> {
    const one = await grantPath({}, [root], join(root, 'a'), ['read'])
    if (!one.ok) throw new Error('setup')
    const two = await grantPath(one.grants, [root], join(root, 'b'), ['write'])
    if (!two.ok) throw new Error('setup')
    return { ...two.grants }
  }

  test('removes the rule for the canonical form of the path (through a symlink)', async () => {
    const grants = await withRules()
    const link = join(base, 'link')
    await symlink(root, link)

    const result = await revokePath(grants, join(link, 'a'))

    expect(result.removed).toBe(true)
    expect(filesOf(result.grants)?.paths).toEqual([{ path: join(root, 'b'), ops: ['write'] }])
    expect(result.remaining).toBe(1)
  })

  test('falls back to the plain resolved path when the folder is gone', async () => {
    const grants = await withRules()
    await rm(join(root, 'a'), { recursive: true })

    const result = await revokePath(grants, join(root, 'a'))

    expect(result.removed).toBe(true)
    expect(result.remaining).toBe(1)
  })

  test('drops the paths field when the last rule goes and says no access remains', async () => {
    const grants = await withRules()
    const first = await revokePath(grants, join(root, 'a'))

    const last = await revokePath(first.grants, join(root, 'b'))

    expect(last.remaining).toBe(0)
    expect(filesOf(last.grants)).toEqual({ tools: '*' })
    expect(filesOf(last.grants)).not.toHaveProperty('paths')
  })

  test('reports removed=false and returns the same grants when no rule matches', async () => {
    const grants = await withRules()

    const result = await revokePath(grants, join(root, 'zzz'))

    expect(result.removed).toBe(false)
    expect(result.grants).toBe(grants)
  })

  test('reports removed=false for an agent without a files grant', async () => {
    const grants: Record<string, AgentGrant> = { github: { tools: '*' } }

    const result = await revokePath(grants, join(root, 'a'))

    expect(result.removed).toBe(false)
    expect(result.remaining).toBe(0)
  })

  test('never mutates its input', async () => {
    const grants = deepFreeze(await withRules())

    await revokePath(grants, join(root, 'a'))

    expect(filesOf(grants)?.paths).toHaveLength(2)
  })
})

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}
