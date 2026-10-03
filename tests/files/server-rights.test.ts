import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeHarness, type Harness } from './server-helpers.js'

describe('files server rights and resilience', () => {
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

  it('applies a revoked right on the very next call', async () => {
    await writeFile(at('f.txt'), 'x')
    expect((await h.call('read_file', { path: at('f.txt') })).isError).toBe(false)
    h.rules = []
    const after = await h.call('read_file', { path: at('f.txt') })
    expect(after.isError).toBe(true)
    expect(after.text).toContain('your rights there are none')
  })

  it('applies a revoked root on the very next call', async () => {
    await writeFile(at('f.txt'), 'x')
    h.roots = []
    const result = await h.call('read_file', { path: at('f.txt') })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('outside your folders')
  })

  it('needs the edit right, not write, to overwrite an existing file', async () => {
    await writeFile(at('f.txt'), 'old')
    h.rules = [{ path: root, ops: ['read', 'write'] }]
    const result = await h.call('write_file', { path: at('f.txt'), content: 'new' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain(`No right to edit ${at('f.txt')}`)
    expect(await readFile(at('f.txt'), 'utf8')).toBe('old')
  })

  it('needs the write right, not edit, to create a new file', async () => {
    h.rules = [{ path: root, ops: ['edit'] }]
    const result = await h.call('write_file', { path: at('n.txt'), content: 'new' })
    expect(result.text).toContain(`No right to write ${at('n.txt')}`)
  })

  it('needs the edit right for edit_file and the write right for create_directory', async () => {
    await writeFile(at('f.txt'), 'x')
    h.rules = [{ path: root, ops: ['read', 'write'] }]
    expect((await h.call('edit_file', { path: at('f.txt'), edits: [{ oldText: 'x', newText: 'y' }] })).text).toContain('No right to edit')
    h.rules = [{ path: root, ops: ['read', 'edit'] }]
    expect((await h.call('create_directory', { path: at('d') })).text).toContain('No right to write')
  })

  it('needs delete on the source and write on the destination to move', async () => {
    await mkdir(at('open'))
    await mkdir(at('ro'))
    await writeFile(at('open', 'a.txt'), 'A')
    h.rules = [
      { path: at('open'), ops: ['read', 'write', 'delete'] },
      { path: at('ro'), ops: ['read'] },
    ]
    const toReadOnly = await h.call('move_file', { source: at('open', 'a.txt'), destination: at('ro', 'a.txt') })
    expect(toReadOnly.text).toContain(`No right to write ${at('ro', 'a.txt')}`)
    expect(await readdir(at('open'))).toEqual(['a.txt'])

    h.rules = [{ path: at('open'), ops: ['read', 'write'] }, { path: at('ro'), ops: ['write'] }]
    const noDelete = await h.call('move_file', { source: at('open', 'a.txt'), destination: at('ro', 'a.txt') })
    expect(noDelete.text).toContain(`No right to delete ${at('open', 'a.txt')}`)

    h.rules = [{ path: at('open'), ops: ['delete'] }, { path: at('ro'), ops: ['write'] }]
    const ok = await h.call('move_file', { source: at('open', 'a.txt'), destination: at('ro', 'a.txt') })
    expect(ok.isError).toBe(false)
    expect(await readdir(at('ro'))).toEqual(['a.txt'])
  })

  it('refuses delete_file without the delete right and keeps the file', async () => {
    await writeFile(at('f.txt'), 'x')
    h.rules = [{ path: root, ops: ['read', 'write', 'edit'] }]
    const result = await h.call('delete_file', { path: at('f.txt') })
    expect(result.text).toContain(`No right to delete ${at('f.txt')}`)
    expect(await readdir(root)).toContain('f.txt')
  })

  it('answers with isError and no stack when a dependency throws, then keeps working', async () => {
    await writeFile(at('f.txt'), 'x')
    h.failNextRoots = true
    const broken = await h.call('read_file', { path: at('f.txt') })
    expect(broken.isError).toBe(true)
    expect(broken.text.split('\n')).toHaveLength(1)
    expect(broken.text).not.toContain('boom')
    expect(broken.text).not.toContain('/secret/stack')
    const next = await h.call('read_file', { path: at('f.txt') })
    expect(next.isError).toBe(false)
  })

  it('stays usable after a rules failure', async () => {
    const original = h.rules
    Object.defineProperty(h, 'rules', { get: () => { throw new Error('db down') }, configurable: true })
    expect((await h.call('list_roots')).isError).toBe(true)
    Object.defineProperty(h, 'rules', { value: original, writable: true, configurable: true })
    expect((await h.call('list_roots')).isError).toBe(false)
  })

  it('handles concurrent calls independently', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeFile(at(`f${i}.txt`), String(i))))
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => h.call('read_file', { path: at(`f${i}.txt`) })))
    expect(results.map((r) => (JSON.parse(r.text) as { text: string }).text)).toEqual(Array.from({ length: 20 }, (_, i) => String(i)))
  })
})
