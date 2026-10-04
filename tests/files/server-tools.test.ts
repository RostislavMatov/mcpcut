import { mkdir, readFile, readdir, symlink, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyTool } from '../../src/policy/classify-tool.js'
import { MAX_PATH_LENGTH, MAX_WRITE_BYTES, TRASH_DIR_NAME } from '../../src/files/constants.js'
import { makeHarness, type Harness } from './server-helpers.js'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

describe('files server tools', () => {
  let h: Harness
  let root: string
  const at = (...segments: string[]): string => join(root, ...segments)
  beforeEach(async () => {
    h = await makeHarness()
    root = h.sandbox.root
  })
  afterEach(async () => {
    await h.sandbox.cleanup()
  })

  it('classifies the published tools so delete is destructive, writes are write, reads are read', async () => {
    const response = await h.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = (response?.['result'] as { tools: { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }[] }).tools
    const classes = Object.fromEntries(tools.map((tool) => [tool.name, classifyTool(tool)]))
    expect(classes).toEqual({
      list_roots: 'read', list_directory: 'read', get_file_info: 'read', read_file: 'read',
      write_file: 'write', create_directory: 'write', edit_file: 'write', move_file: 'write', delete_file: 'destructive',
    })
  })

  describe('happy paths', () => {
    it('list_roots shows the granted folders with sorted ops, merged and inside a root only', async () => {
      await mkdir(at('b'))
      await mkdir(at('a'))
      h.rules = [
        { path: at('b'), ops: ['write', 'read'] },
        { path: at('a'), ops: ['read'] },
        { path: at('a'), ops: ['delete'] },
        { path: at('b', 'cut'), ops: [] },
        { path: h.sandbox.base, ops: ['read'] },
      ]
      const result = await h.call('list_roots')
      expect(result.isError).toBe(false)
      expect(JSON.parse(result.text)).toEqual({
        folders: [
          { path: at('a'), ops: ['read', 'delete'] },
          { path: at('b'), ops: ['read', 'write'] },
        ],
      })
    })

    it('list_roots says how to get folders when there are none', async () => {
      h.rules = []
      const result = await h.call('list_roots')
      expect(result.isError).toBe(false)
      expect(result.text).toContain('mcpcut files grant')
    })

    it('list_directory lists entries sorted with kinds and sizes', async () => {
      await writeFile(at('b.txt'), 'hello')
      await mkdir(at('a-dir'))
      const result = await h.call('list_directory', { path: root })
      expect(result.isError).toBe(false)
      expect(JSON.parse(result.text)).toEqual({
        entries: [{ name: 'a-dir', kind: 'directory' }, { name: 'b.txt', kind: 'file', size: 5 }],
        truncated: false,
      })
    })

    it('get_file_info describes a file', async () => {
      await writeFile(at('f.txt'), 'abc')
      const info = JSON.parse((await h.call('get_file_info', { path: at('f.txt') })).text)
      expect(info).toMatchObject({ kind: 'file', size: 3, nlink: 1 })
    })

    it('read_file returns the text with its hash', async () => {
      await writeFile(at('f.txt'), 'héllo\nworld')
      const result = await h.call('read_file', { path: at('f.txt') })
      expect(JSON.parse(result.text)).toMatchObject({ text: 'héllo\nworld', sha256: sha('héllo\nworld'), size: 7 + 5 })
    })

    it('write_file creates a new file with the write right', async () => {
      const result = await h.call('write_file', { path: at('new.txt'), content: 'data' })
      expect(result.isError).toBe(false)
      expect(JSON.parse(result.text)).toMatchObject({ size: 4, sha256: sha('data') })
      expect(await readFile(at('new.txt'), 'utf8')).toBe('data')
    })

    it('write_file overwrites an existing file guarded by expectedSha256', async () => {
      await writeFile(at('f.txt'), 'old')
      const stale = await h.call('write_file', { path: at('f.txt'), content: 'new', expectedSha256: sha('other') })
      expect(stale.isError).toBe(true)
      expect(await readFile(at('f.txt'), 'utf8')).toBe('old')
      const ok = await h.call('write_file', { path: at('f.txt'), content: 'new', expectedSha256: sha('old').toUpperCase() })
      expect(ok.isError).toBe(false)
      expect(await readFile(at('f.txt'), 'utf8')).toBe('new')
    })

    it('create_directory makes a folder', async () => {
      const result = await h.call('create_directory', { path: at('made') })
      expect(result.isError).toBe(false)
      expect(await readdir(at('made'))).toEqual([])
    })

    it('edit_file applies edits', async () => {
      await writeFile(at('f.txt'), 'one two three')
      const result = await h.call('edit_file', {
        path: at('f.txt'),
        edits: [{ oldText: 'one', newText: '1' }, { oldText: 'three', newText: '3' }],
        expectedSha256: sha('one two three'),
      })
      expect(result.isError).toBe(false)
      expect(await readFile(at('f.txt'), 'utf8')).toBe('1 two 3')
    })

    it('edit_file reports an edit that does not match exactly once', async () => {
      await writeFile(at('f.txt'), 'x x')
      const result = await h.call('edit_file', { path: at('f.txt'), edits: [{ oldText: 'x', newText: 'y' }] })
      expect(result.isError).toBe(true)
      expect(result.text).toContain('exactly once')
      expect(await readFile(at('f.txt'), 'utf8')).toBe('x x')
    })

    it('move_file renames a file', async () => {
      await writeFile(at('a.txt'), 'A')
      const result = await h.call('move_file', { source: at('a.txt'), destination: at('b.txt') })
      expect(result.isError).toBe(false)
      expect(await readdir(root)).toContain('b.txt')
      expect(await readdir(root)).not.toContain('a.txt')
    })

    it('delete_file puts the item in the trash and the listing no longer shows it', async () => {
      await writeFile(at('gone.txt'), 'bye')
      const result = await h.call('delete_file', { path: at('gone.txt') })
      expect(result.isError).toBe(false)
      expect(result.text).toContain('trash')
      expect(result.text).toContain('administrator can restore')
      const id = (await readdir(join(root, TRASH_DIR_NAME))).find((name) => name.endsWith('.json'))?.replace('.json', '')
      expect(result.text).toContain(`id ${id}`)
      expect(result.text.replace(at('gone.txt'), '')).not.toContain(root)
      expect(result.text).not.toContain('mcpcut files')
      const listing = JSON.parse((await h.call('list_directory', { path: root })).text) as { entries: { name: string }[] }
      expect(listing.entries).toEqual([])
      expect(await readdir(join(root, TRASH_DIR_NAME))).toHaveLength(2)
    })
  })

  describe('refusals', () => {
    it('refuses a path outside the roots with the resolver message', async () => {
      const result = await h.call('read_file', { path: join(h.sandbox.base, 'elsewhere.txt') })
      expect(result).toEqual({ isError: true, text: expect.stringContaining('outside your folders') })
    })

    it('refuses a relative path', async () => {
      const result = await h.call('read_file', { path: 'a.txt' })
      expect(result.isError).toBe(true)
      expect(result.text).toContain('absolute path')
    })

    it('refuses an empty path with the resolver message', async () => {
      const result = await h.call('list_directory', { path: '' })
      expect(result.isError).toBe(true)
      expect(result.text).toContain('empty')
    })

    it('refuses the trash folder', async () => {
      const result = await h.call('list_directory', { path: at(TRASH_DIR_NAME) })
      expect(result.isError).toBe(true)
      expect(result.text).toContain('trash')
    })

    it('refuses a symlink that leads out of the root and never shows the target content', async () => {
      const outside = join(h.sandbox.base, 'outside')
      await mkdir(outside)
      await writeFile(join(outside, 'secret.txt'), 'TOP-SECRET-CONTENT')
      await symlink(outside, at('link'))
      const result = await h.call('read_file', { path: at('link', 'secret.txt') })
      expect(result.isError).toBe(true)
      expect(result.text).not.toContain('TOP-SECRET-CONTENT')
    })

    it('reports a missing file', async () => {
      const result = await h.call('read_file', { path: at('nope.txt') })
      expect(result.isError).toBe(true)
    })

    it('says the exact missing right and the rights held', async () => {
      h = await replaceHarness(h, ['read'])
      root = h.sandbox.root
      const target = join(root, 'x.txt')
      const result = await h.call('write_file', { path: target, content: 'x' })
      expect(result).toEqual({
        isError: true,
        text: `No right to write ${target}: your rights there are read. Call list_roots to see your folders.`,
      })
    })

    it('says "none" where a rule cuts the folder out', async () => {
      await mkdir(at('secret'))
      await writeFile(at('secret', 's.txt'), 'hidden')
      h.rules = [{ path: root, ops: ['read', 'write', 'edit', 'delete'] }, { path: at('secret'), ops: [] }]
      const result = await h.call('read_file', { path: at('secret', 's.txt') })
      expect(result.isError).toBe(true)
      expect(result.text).toBe(`No right to read ${at('secret', 's.txt')}: your rights there are none. Call list_roots to see your folders.`)
      expect(result.text).not.toContain('hidden')
    })

    it('closes all access when a granted folder was replaced by a symlink', async () => {
      const elsewhere = join(h.sandbox.base, 'elsewhere')
      await mkdir(elsewhere)
      await mkdir(at('granted'))
      h.rules = [{ path: at('granted'), ops: ['read'] }]
      expect((await h.call('list_directory', { path: at('granted') })).isError).toBe(false)
      await rm(at('granted'), { recursive: true })
      await symlink(elsewhere, at('granted'))
      const result = await h.call('list_directory', { path: at('granted') })
      expect(result.isError).toBe(true)
      expect(result.text).toContain('mcpcut files grant')
      const roots = await h.call('list_roots')
      expect(roots.isError).toBe(true)
      expect(roots.text).toContain('mcpcut files grant')
    })

    it('closes access when a granted folder cannot be resolved', async () => {
      await symlink(at('loop'), at('loop'))
      h.rules = [{ path: at('loop'), ops: ['read'] }]
      const result = await h.call('list_directory', { path: root })
      expect(result.isError).toBe(true)
      expect(result.text).toContain('cannot be resolved')
    })

    it('reports an unreachable trash when deleting', async () => {
      await writeFile(at('f.txt'), 'x')
      await rm(join(root, TRASH_DIR_NAME), { recursive: true })
      const result = await h.call('delete_file', { path: at('f.txt') })
      expect(result.isError).toBe(true)
      expect(await readFile(at('f.txt'), 'utf8')).toBe('x')
    })

    it('summarizes bad arguments from the schema', async () => {
      const result = await h.call('write_file', { path: 5, content: 'x', extra: true })
      expect(result.isError).toBe(true)
      expect(result.text.split('\n')).toHaveLength(1)
      expect(result.text).toContain('Invalid arguments for write_file')
      expect(result.text).toContain('path')
    })

    it.each([undefined, null, 'str', []])('treats arguments %j as invalid when a path is required', async (args) => {
      const result = await h.call('read_file', args)
      expect(result.isError).toBe(true)
      expect(result.text).toContain('Invalid arguments for read_file')
    })

    it('rejects an edits list that is empty or has more than 100 edits', async () => {
      await writeFile(at('f.txt'), 'x')
      const empty = await h.call('edit_file', { path: at('f.txt'), edits: [] })
      const many = await h.call('edit_file', { path: at('f.txt'), edits: Array.from({ length: 101 }, () => ({ oldText: 'x', newText: 'y' })) })
      expect(empty.isError).toBe(true)
      expect(many.isError).toBe(true)
    })

    it('rejects a malformed expectedSha256', async () => {
      const result = await h.call('write_file', { path: at('a'), content: 'x', expectedSha256: 'abc' })
      expect(result.isError).toBe(true)
      expect(result.text).toContain('expectedSha256')
    })

    it('refuses a path longer than the limit', async () => {
      const result = await h.call('read_file', { path: `/${'a'.repeat(MAX_PATH_LENGTH)}` })
      expect(result.isError).toBe(true)
    })

    it('refuses content over the write limit by UTF-8 length and writes nothing', async () => {
      const content = '€'.repeat(Math.floor(MAX_WRITE_BYTES / 3) + 1)
      expect(content.length).toBeLessThan(MAX_WRITE_BYTES)
      const result = await h.call('write_file', { path: at('big.txt'), content })
      expect(result.isError).toBe(true)
      expect(result.text).toContain('MiB')
      expect(await readdir(root)).not.toContain('big.txt')
    })

    it('refuses an unknown tool in one line', async () => {
      const result = await h.call('format_disk', {})
      expect(result.isError).toBe(true)
      expect(result.text).toContain('format_disk')
    })
  })
})

async function replaceHarness(old: Harness, ops: readonly ('read' | 'write' | 'edit' | 'delete')[]): Promise<Harness> {
  await old.sandbox.cleanup()
  return makeHarness(ops)
}
