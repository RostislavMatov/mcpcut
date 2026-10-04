import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFilesArgsCheck } from '../../src/files/args-check.js'
import type { FileOp } from '../../src/files/constants.js'
import type { FilesBackend } from '../../src/files/upstream.js'
import { makeHarness, type Harness } from './server-helpers.js'

/** Security review: H1 (folders hide rules), M1 (edit needs read), M2 (move cannot widen rights). Server and gate agree. */

let h: Harness
let root: string
const at = (...segments: string[]): string => join(root, ...segments)
const gate = (toolName: string, args: unknown) => {
  const backend: FilesBackend = { actor: 'tester', roots: async () => h.roots, rules: async () => h.rules }
  return createFilesArgsCheck(backend)({ toolName, args, id: 1 })
}
const ALL: readonly FileOp[] = ['read', 'write', 'edit', 'delete']

beforeEach(async () => {
  h = await makeHarness()
  root = h.sandbox.root
})
afterEach(async () => {
  await h.sandbox.cleanup()
})

describe('H1: a moved or deleted folder cannot carry a separate grant out of its rules', () => {
  const MESSAGE = 'contains a separately granted folder'

  it('refuses to move a folder holding a cut-out', async () => {
    await mkdir(at('proj', 'secret'), { recursive: true })
    h.rules = [{ path: root, ops: ALL }, { path: at('proj', 'secret'), ops: [] }]
    const result = await h.call('move_file', { source: at('proj'), destination: at('moved') })
    expect(result.isError).toBe(true)
    expect(result.text).toBe(`${at('proj')} contains a separately granted folder ${at('proj', 'secret')}; move or delete what is inside instead, or ask an administrator`)
    expect(await readdir(root)).toContain('proj')
    expect((await gate('move_file', { source: at('proj'), destination: at('moved') }))?.reason).toContain(MESSAGE)
  })

  it('refuses to move a folder holding a read-only subfolder', async () => {
    await mkdir(at('proj', 'ro'), { recursive: true })
    h.rules = [{ path: root, ops: ALL }, { path: at('proj', 'ro'), ops: ['read'] }]
    const result = await h.call('move_file', { source: at('proj'), destination: at('moved') })
    expect(result.text).toContain(MESSAGE)
    expect(await readdir(root)).not.toContain('moved')
  })

  it('refuses to delete a folder holding a cut-out', async () => {
    await mkdir(at('proj', 'secret'), { recursive: true })
    h.rules = [{ path: root, ops: ALL }, { path: at('proj', 'secret'), ops: [] }]
    const result = await h.call('delete_file', { path: at('proj') })
    expect(result.isError).toBe(true)
    expect(result.text).toContain(MESSAGE)
    expect(await readdir(root)).toContain('proj')
    expect((await gate('delete_file', { path: at('proj') }))?.rule).toBe('files: separately granted folder inside')
  })

  it('refuses a folder that holds a nested root', async () => {
    await mkdir(at('proj', 'inner'), { recursive: true })
    h.roots = [root, at('proj', 'inner')]
    const result = await h.call('delete_file', { path: at('proj') })
    expect(result.text).toContain(`${at('proj', 'inner')}`)
    expect(result.text).toContain(MESSAGE)
  })

  it('still moves and deletes a plain folder and a file', async () => {
    await mkdir(at('plain'))
    await writeFile(at('f.txt'), 'x')
    expect((await h.call('move_file', { source: at('plain'), destination: at('plain2') })).isError).toBe(false)
    expect((await h.call('delete_file', { path: at('plain2') })).isError).toBe(false)
    expect((await h.call('delete_file', { path: at('f.txt') })).isError).toBe(false)
  })

  it('does not refuse a folder whose rule sits beside it, not inside', async () => {
    await mkdir(at('a'))
    await mkdir(at('b'))
    h.rules = [{ path: root, ops: ALL }, { path: at('b'), ops: [] }]
    expect((await h.call('delete_file', { path: at('a') })).isError).toBe(false)
  })
})

describe('M1: edit needs read, a guarded write needs read', () => {
  it('edit_file with edit but without read is refused by server and gate', async () => {
    await writeFile(at('f.txt'), 'x')
    h.rules = [{ path: root, ops: ['edit'] }]
    const args = { path: at('f.txt'), edits: [{ oldText: 'x', newText: 'y' }] }
    expect((await h.call('edit_file', args)).text).toContain(`No right to read ${at('f.txt')}`)
    expect((await gate('edit_file', args))?.rule).toBe(`files: no right read on ${at('f.txt')}`)
    expect(await readFile(at('f.txt'), 'utf8')).toBe('x')
  })

  it('edit_file with read and edit passes the gate', async () => {
    h.rules = [{ path: root, ops: ['read', 'edit'] }]
    expect(await gate('edit_file', { path: at('f.txt'), edits: [{ oldText: 'x', newText: 'y' }] })).toBeNull()
  })

  it('write_file on an existing file with edit only works without expectedSha256', async () => {
    await writeFile(at('f.txt'), 'old')
    h.rules = [{ path: root, ops: ['edit'] }]
    expect((await h.call('write_file', { path: at('f.txt'), content: 'new' })).isError).toBe(false)
    expect(await gate('write_file', { path: at('f.txt'), content: 'n' })).toBeNull()
  })

  it('write_file with expectedSha256 also needs read', async () => {
    await writeFile(at('f.txt'), 'old')
    h.rules = [{ path: root, ops: ['edit'] }]
    const args = { path: at('f.txt'), content: 'new', expectedSha256: 'a'.repeat(64) }
    expect((await h.call('write_file', args)).text).toContain(`No right to read ${at('f.txt')}`)
    expect((await gate('write_file', args))?.rule).toBe(`files: no right read on ${at('f.txt')}`)
    expect(await readFile(at('f.txt'), 'utf8')).toBe('old')
  })

  it('write_file creating a new file with expectedSha256 only needs write', async () => {
    h.rules = [{ path: root, ops: ['write'] }]
    const args = { path: at('n.txt'), content: 'new', expectedSha256: 'a'.repeat(64) }
    expect(await gate('write_file', args)).toBeNull()
  })
})

describe('M2: a move cannot give the entry rights the source lacks', () => {
  async function folders(source: readonly FileOp[], destination: readonly FileOp[]): Promise<void> {
    await mkdir(at('src'))
    await mkdir(at('dst'))
    await writeFile(at('src', 'f.txt'), 'x')
    h.rules = [{ path: at('src'), ops: source }, { path: at('dst'), ops: destination }]
  }

  it('refuses moving from a delete-only outbox into a read folder', async () => {
    await folders(['delete'], ['write', 'read'])
    const args = { source: at('src', 'f.txt'), destination: at('dst', 'f.txt') }
    const result = await h.call('move_file', args)
    expect(result.isError).toBe(true)
    expect(result.text).toContain(`No right to read ${at('src', 'f.txt')}`)
    expect((await gate('move_file', args))?.rule).toBe(`files: no right read on ${at('src', 'f.txt')}`)
    expect(await readdir(at('src'))).toContain('f.txt')
  })

  it('names edit when the destination would allow editing', async () => {
    await folders(['delete', 'read'], ['write', 'edit'])
    const result = await h.call('move_file', { source: at('src', 'f.txt'), destination: at('dst', 'f.txt') })
    expect(result.text).toContain(`No right to edit ${at('src', 'f.txt')}`)
  })

  it('moves between folders with equal rights', async () => {
    await folders(['delete', 'read', 'edit'], ['write', 'read', 'edit'])
    const args = { source: at('src', 'f.txt'), destination: at('dst', 'f.txt') }
    expect((await h.call('move_file', args)).isError).toBe(false)
    expect(await readdir(at('dst'))).toContain('f.txt')
  })

  it('allows moving into a folder with fewer rights (write only)', async () => {
    await folders(['delete', 'read', 'edit'], ['write'])
    const args = { source: at('src', 'f.txt'), destination: at('dst', 'f.txt') }
    expect(await gate('move_file', args)).toBeNull()
  })
})

describe('LOW 3: the delete answer names no folder above the grant', () => {
  it('shows the path the agent used and the id, not the root', async () => {
    await mkdir(at('granted'))
    await writeFile(at('granted', 'f.txt'), 'x')
    h.rules = [{ path: at('granted'), ops: ['delete'] }]
    const result = await h.call('delete_file', { path: at('granted', 'f.txt') })
    expect(result.isError).toBe(false)
    expect(result.text).toMatch(/\(id [0-9A-Z]{26}\)/)
    expect(result.text.replace(at('granted', 'f.txt'), '')).not.toContain(root)
    expect(result.text).toContain('administrator can restore it by that id')
  })
})
