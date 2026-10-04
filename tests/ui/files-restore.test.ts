import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { AUDIT_RECORD_DROPPED_WARNING } from '../../src/ui/constants.js'
import { HOSTED_MESSAGE } from '../../src/ui/handlers/files.js'
import type { TenantSettings } from '../../src/tenant/settings.js'
import { renderLayout } from '../../src/ui/pages/layout.js'
import { html } from '../../src/ui/html.js'
import { bodyOf, getCtx, makeFixture, postCtx, session, statusOf, type FilesFixture } from './files-support.js'

/**
 * `POST /files/trash/restore` and the hosted refusal: every refusal leaves the
 * trash untouched, the happy path puts the file back and leaves one audit line
 * and one `files.trash.restore` journal record attributed to the UI.
 */

const HOSTED: TenantSettings = {
  isTenant: true,
  stdioServers: 'refused',
  upstreams: 'public-https',
  limits: { servers: 5, agents: 5, groups: 2, requestsPerSecond: 10, requestsPerDay: 10_000 },
}

let fx: FilesFixture
let id: string

beforeEach(async () => {
  fx = await makeFixture()
  await fx.declareRoot()
  id = await fx.trashFile('docs/note.txt')
})

afterEach(async () => {
  await fx.cleanup()
})

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false)
}

async function trashStillHolds(): Promise<boolean> {
  return exists(join(fx.root, '.mcpcut-trash', `${id}.json`))
}

describe('a successful restore', () => {
  test('puts the file back, says where, attributes it and journals it as a UI edit', async () => {
    const result = await fx.handlers().filesTrashRestore(postCtx({ root: fx.root, id }, session('owner', 'olga')))

    const target = join(fx.root, 'docs', 'note.txt')
    expect(statusOf(result)).toBe(200)
    expect(await readFile(target, 'utf8')).toBe('content')
    expect(await trashStillHolds()).toBe(false)
    const page = bodyOf(result)
    expect(page).toContain(`Restored ${target}.`)
    expect(page).toContain('Agents with rights on that folder can use it again.')
    expect(page).toContain('<a href="/files">Back to files</a>')
    expect(fx.audit).toEqual([{ actor: 'ui', adminName: 'olga', action: 'files.trash.restore', target }])
    expect(fx.edits).toEqual([
      { actor: { adminName: 'olga', role: 'owner', via: 'ui' }, action: 'files.trash.restore', path: target, trashId: id },
    ])
  })

  test('a dropped journal record still restores and carries the warning', async () => {
    const handlers = fx.handlers({ journalAccessEdit: async () => ({ written: false }) })

    const result = await handlers.filesTrashRestore(postCtx({ root: fx.root, id }, session('owner')))

    expect(statusOf(result)).toBe(200)
    expect(bodyOf(result)).toContain(AUDIT_RECORD_DROPPED_WARNING)
    expect(await exists(join(fx.root, 'docs', 'note.txt'))).toBe(true)
  })

  test('a journal port that throws is contained', async () => {
    const handlers = fx.handlers({
      journalAccessEdit: async () => {
        throw new Error('disk full')
      },
    })

    const result = await handlers.filesTrashRestore(postCtx({ root: fx.root, id }, session('owner')))

    expect(statusOf(result)).toBe(200)
    expect(bodyOf(result)).toContain(AUDIT_RECORD_DROPPED_WARNING)
  })
})

describe('refusals never touch the trash', () => {
  async function expectRefused(form: Record<string, string>, message: string): Promise<void> {
    const result = await fx.handlers().filesTrashRestore(postCtx(form, session('owner')))

    expect(statusOf(result)).toBe(400)
    const page = bodyOf(result)
    expect(page).toContain(message)
    expect(page).toContain('<a href="/files#trash">Back to the trash</a>')
    expect(await trashStillHolds()).toBe(true)
    expect(await exists(join(fx.root, 'docs', 'note.txt'))).toBe(false)
    expect(fx.audit).toEqual([])
    expect(fx.edits).toEqual([])
  }

  test('a folder that is not declared', async () => {
    await expectRefused({ root: join(fx.base, 'elsewhere'), id }, 'that folder is not declared')
  })

  test('an id that is not a trash id', async () => {
    await expectRefused({ root: fx.root, id: '../../etc/passwd' }, 'not a trash id')
  })

  test('missing fields', async () => {
    await expectRefused({ root: fx.root }, 'folder and trash id are required')
  })

  test('an io failure shows its message', async () => {
    await expectRefused({ root: fx.root, id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }, 'Nothing exists')
  })

  test('something already at the original path', async () => {
    await writeFile(join(fx.root, 'docs', 'note.txt'), 'newer')

    const result = await fx.handlers().filesTrashRestore(postCtx({ root: fx.root, id }, session('owner')))

    expect(statusOf(result)).toBe(400)
    expect(bodyOf(result)).toContain('Something already exists at the original path')
    expect(await readFile(join(fx.root, 'docs', 'note.txt'), 'utf8')).toBe('newer')
    expect(await trashStillHolds()).toBe(true)
    expect(fx.edits).toEqual([])
  })

  test('no session at all', async () => {
    const result = await fx.handlers().filesTrashRestore(postCtx({ root: fx.root, id }, undefined))

    expect(statusOf(result)).toBe(403)
    expect(await trashStillHolds()).toBe(true)
  })
})

describe('a hosted install', () => {
  test('GET /files answers a notice and no page', async () => {
    const result = await fx.handlers({ tenant: HOSTED }).filesPage(getCtx(session('owner')))

    expect(statusOf(result)).toBe(404)
    expect(bodyOf(result)).toContain(HOSTED_MESSAGE)
    expect(bodyOf(result)).not.toContain('id="folders"')
  })

  test('POST refuses without touching disk', async () => {
    const result = await fx.handlers({ tenant: HOSTED }).filesTrashRestore(postCtx({ root: fx.root, id }, session('owner')))

    expect(statusOf(result)).toBe(404)
    expect(bodyOf(result)).toContain(HOSTED_MESSAGE)
    expect(await trashStillHolds()).toBe(true)
    expect(fx.edits).toEqual([])
  })

  test('the layout hides the Files tab when hosted and shows it otherwise', () => {
    const options = { title: 'T', content: html`<p>x</p>`, csrfToken: 'c', currentAdmin: { name: 'a', role: 'viewer' } }

    expect(renderLayout({ ...options, isHosted: true })).not.toContain('href="/files"')
    expect(renderLayout({ ...options, isHosted: false })).toContain('<a class="tab" href="/files">Files</a>')
  })
})
