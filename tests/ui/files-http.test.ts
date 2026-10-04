import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { makeFixture, type FilesFixture } from './files-support.js'
import { startUiHarness, type UiTestHarness } from './harness.js'

/** The composed server: route table roles, CSRF and the nav, over a real socket. */

let fx: FilesFixture
let ui: UiTestHarness
let id: string

beforeEach(async () => {
  fx = await makeFixture()
  await fx.declareRoot()
  id = await fx.trashFile('docs/note.txt')
  ui = await startUiHarness({ journalDir: fx.journalDir })
})

afterEach(async () => {
  await ui.stop()
  await fx.cleanup()
})

const stillInTrash = (): Promise<boolean> =>
  access(join(fx.root, '.mcpcut-trash', `${id}.json`)).then(() => true, () => false)

describe('GET /files', () => {
  test.each(['ui-owner', 'ui-operator', 'ui-viewer'])('%s gets the page with the Files tab', async (name) => {
    const response = await (await ui.login(name)).get('/files')

    expect(response.status).toBe(200)
    expect(response.body).toContain('id="trash"')
    expect(response.body).toContain('href="/files"')
  })

  test('only the owner is offered the Restore button', async () => {
    const owner = await (await ui.login('ui-owner')).get('/files')
    const viewer = await (await ui.login('ui-viewer')).get('/files')

    expect(owner.body).toContain('action="/files/trash/restore"')
    expect(viewer.body).not.toContain('action="/files/trash/restore"')
  })
})

describe('POST /files/trash/restore', () => {
  test('an owner restores through the full stack', async () => {
    const response = await (await ui.login('ui-owner')).post('/files/trash/restore', { root: fx.root, id })

    expect(response.status).toBe(200)
    expect(response.body).toContain('Restored')
    expect(await stillInTrash()).toBe(false)
  })

  test.each(['ui-operator', 'ui-viewer'])('%s is refused and the trash is untouched', async (name) => {
    const response = await (await ui.login(name)).post('/files/trash/restore', { root: fx.root, id })

    expect(response.status).toBe(403)
    expect(await stillInTrash()).toBe(true)
  })

  test('a POST without the CSRF token fails and the trash is untouched', async () => {
    const response = await (await ui.login('ui-owner')).postWithoutCsrf('/files/trash/restore', { root: fx.root, id })

    expect(response.status).toBe(403)
    expect(await stillInTrash()).toBe(true)
  })
})
