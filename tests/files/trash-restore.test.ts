import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { moveToTrash } from '../../src/files/io-trash.js'
import { findDeclaredRoot, restoreInDeclaredRoot } from '../../src/files/trash-restore.js'
import { makeSandbox, valueOf, type Sandbox } from './io-helpers.js'

/** The one root-resolution + restore path shared by `files trash restore` and the Files page. */

let sandbox: Sandbox

beforeAll(async () => {
  sandbox = await makeSandbox('trash-restore')
})

afterAll(async () => {
  await sandbox.cleanup()
})

async function trashed(name: string): Promise<string> {
  await mkdir(join(sandbox.root, 'docs'), { recursive: true })
  await writeFile(join(sandbox.root, 'docs', name), 'content')
  return valueOf(await moveToTrash(await sandbox.resolve('docs', name), 'agent-me')).id
}

describe('findDeclaredRoot', () => {
  test('returns the declared root the argument names', async () => {
    expect(await findDeclaredRoot([sandbox.root], sandbox.root)).toBe(sandbox.root)
  })

  test('returns undefined for a folder that is not declared', async () => {
    expect(await findDeclaredRoot([sandbox.root], join(sandbox.base, 'elsewhere'))).toBeUndefined()
  })

  test('returns undefined when nothing is declared', async () => {
    expect(await findDeclaredRoot([], sandbox.root)).toBeUndefined()
  })
})

describe('restoreInDeclaredRoot', () => {
  test('puts the item back and reports the restored path', async () => {
    const id = await trashed('back.txt')
    const outcome = await restoreInDeclaredRoot([sandbox.root], sandbox.root, id)
    expect(outcome).toMatchObject({ status: 'restored', root: sandbox.root, target: join(sandbox.root, 'docs', 'back.txt') })
    expect(await readFile(join(sandbox.root, 'docs', 'back.txt'), 'utf8')).toBe('content')
  })

  test('refuses an undeclared root without touching the trash', async () => {
    const id = await trashed('keep.txt')
    const outcome = await restoreInDeclaredRoot([], sandbox.root, id)
    expect(outcome).toEqual({ status: 'no-root' })
    await expect(readFile(join(sandbox.root, 'docs', 'keep.txt'))).rejects.toThrow()
  })

  test('refuses an id that is not a trash id', async () => {
    const outcome = await restoreInDeclaredRoot([sandbox.root], sandbox.root, '../etc')
    expect(outcome).toMatchObject({ status: 'failed', root: sandbox.root })
  })

  test('carries the io message when the restore fails', async () => {
    const outcome = await restoreInDeclaredRoot([sandbox.root], sandbox.root, '01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(outcome).toMatchObject({ status: 'failed', message: expect.stringMatching(/\S/) })
  })
})
