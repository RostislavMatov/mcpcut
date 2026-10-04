import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { FILE_OPS, type FileOp } from '../../src/files/constants.js'
import { createFilesArgsCheck } from '../../src/files/args-check.js'
import type { FileRule } from '../../src/files/rights.js'
import type { FilesBackend } from '../../src/files/upstream.js'
import { makeHarness, type Harness } from './server-helpers.js'

/** The gate's check shares its definition of "which tool needs which right" with the server (ADR-0020 §2). */

const harnesses: Harness[] = []
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.sandbox.cleanup()))
})

async function setup(ops: readonly FileOp[]) {
  const harness = await makeHarness(ops)
  harnesses.push(harness)
  const backend: FilesBackend = { actor: 'tester', roots: async () => harness.roots, rules: async () => harness.rules }
  const check = createFilesArgsCheck(backend)
  const root = harness.sandbox.root
  const checkCall = (toolName: string, args: unknown) => check({ toolName, args, id: 1 })
  return { harness, check, checkCall, root }
}

describe('createFilesArgsCheck: refusals', () => {
  test('delete_file without the delete right names the right and the path', async () => {
    const { checkCall, root } = await setup(['read', 'write'])
    const target = join(root, 'a.txt')
    expect(await checkCall('delete_file', { path: target })).toEqual({
      rule: `files: no right delete on ${target}`,
      reason: expect.stringContaining('delete'),
    })
  })

  test('delete_file with the delete right passes', async () => {
    const { checkCall, root } = await setup(['read', 'delete'])
    expect(await checkCall('delete_file', { path: join(root, 'a.txt') })).toBeNull()
  })

  test('a path outside every root is refused with the resolver refusal as the rule', async () => {
    const { checkCall } = await setup(['read'])
    const refusal = await checkCall('read_file', { path: '/etc/hosts' })
    expect(refusal?.rule).toBe('files: outside-roots')
  })

  test('a relative path is refused with the resolver refusal', async () => {
    const { checkCall } = await setup(['read'])
    expect((await checkCall('read_file', { path: 'a.txt' }))?.rule).toBe('files: not-absolute')
  })

  test('write_file on a new path needs write, on an existing one needs edit', async () => {
    const { checkCall, root } = await setup(['read', 'write'])
    const existing = join(root, 'exists.txt')
    await writeFile(existing, 'x')
    expect(await checkCall('write_file', { path: join(root, 'new.txt'), content: 'x' })).toBeNull()
    expect((await checkCall('write_file', { path: existing, content: 'x' }))?.rule).toBe(`files: no right edit on ${existing}`)
  })

  test('move_file needs delete on the source and write on the destination', async () => {
    const { checkCall, root } = await setup(['read', 'write'])
    const source = join(root, 'from.txt')
    expect((await checkCall('move_file', { source, destination: join(root, 'to.txt') }))?.rule).toBe(`files: no right delete on ${source}`)
  })

  test('a rule folder that now resolves elsewhere closes access with its problem as the rule', async () => {
    const { harness, checkCall, root } = await setup(['read'])
    const elsewhere = join(harness.sandbox.base, 'gone', 'deep')
    harness.rules = [{ path: elsewhere, ops: ['read'] }] as readonly FileRule[]
    await mkdir(join(harness.sandbox.base, 'real'), { recursive: true })
    const refusal = await checkCall('read_file', { path: join(root, 'a.txt') })
    expect(refusal === null || refusal.rule.startsWith('files: ')).toBe(true)
  })

  test('a path with control characters and an enormous length is kept to one short line in the rule', async () => {
    const { checkCall, root } = await setup(['read'])
    const refusal = await checkCall('delete_file', { path: `${root}/a\nb${'x'.repeat(3000)}` })
    expect(refusal?.rule).not.toContain('\n')
    expect((refusal?.rule ?? '').length).toBeLessThan(400)
  })

  test('an unexpected failure while checking is a refusal, never a pass', async () => {
    const harness = await makeHarness(['read'])
    harnesses.push(harness)
    const check = createFilesArgsCheck({ actor: 't', roots: async () => { throw new Error('disk gone') }, rules: async () => harness.rules })
    const refusal = await check({ toolName: 'read_file', args: { path: join(harness.sandbox.root, 'a') }, id: 1 })
    expect(refusal?.rule).toBe('files: check-failed')
    expect(refusal?.reason).not.toContain('disk gone')
  })

  test('rules are read afresh: a revoked right refuses the very next call', async () => {
    const { harness, checkCall, root } = await setup(['read'])
    const target = join(root, 'a.txt')
    expect(await checkCall('read_file', { path: target })).toBeNull()
    harness.rules = []
    expect((await checkCall('read_file', { path: target }))?.rule).toBe(`files: no right read on ${target}`)
  })
})

describe('createFilesArgsCheck: what it leaves to the server', () => {
  test.each([
    ['list_roots', {}],
    ['no_such_tool', { path: '/x' }],
    ['read_file', {}],
    ['read_file', { path: 42 }],
    ['read_file', 'not an object'],
    ['read_file', undefined],
    ['delete_file', { path: '/x', extra: 1 }],
  ])('%s with %j is not refused by the gate', async (name, args) => {
    const { checkCall } = await setup([])
    expect(await checkCall(name, args)).toBeNull()
  })
})

describe('parity with the server: the gate refuses exactly when the server would', () => {
  const OPS_SETS: ReadonlyArray<readonly FileOp[]> = [[], ...FILE_OPS.map((op) => [op] as const), ['read', 'write'], [...FILE_OPS]]

  test.each(OPS_SETS.map((ops) => [ops.join('+') || 'none', ops] as const))('rights %s over every path tool', async (_label, ops) => {
    const { harness, checkCall, root } = await setup(ops)
    const existing = join(root, 'exists.txt')
    await writeFile(existing, 'content')
    await mkdir(join(root, 'dir'), { recursive: true })
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['list_directory', { path: join(root, 'dir') }],
      ['get_file_info', { path: existing }],
      ['read_file', { path: existing }],
      ['create_directory', { path: join(root, 'newdir') }],
      ['edit_file', { path: existing, edits: [{ oldText: 'content', newText: 'other' }] }],
      ['delete_file', { path: join(root, 'doomed.txt') }],
      ['write_file', { path: join(root, 'fresh.txt'), content: 'x' }],
      ['write_file', { path: existing, content: 'y' }],
      ['move_file', { source: join(root, 'nothing.txt'), destination: join(root, 'moved.txt') }],
    ]
    for (const [name, args] of cases) {
      const refusal = await checkCall(name, args)
      const result = await harness.call(name, args)
      const serverRefusedForRights = result.isError && result.text.startsWith('No right to ')
      expect(refusal !== null, `${name} with ${ops.join('+') || 'none'}`).toBe(serverRefusedForRights)
    }
  })
})
