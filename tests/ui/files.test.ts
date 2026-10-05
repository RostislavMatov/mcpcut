import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { trashDirOf, writeManifest } from '../../src/files/trash-manifest.js'
import { PRODUCT_VERSION } from '../../src/brand.js'
import { NOW, bodyOf, decision, getCtx, makeFixture, session, statusOf, type FilesFixture } from './files-support.js'

/**
 * The `/files` page (ADR-0020): four panels over the real roots, agents,
 * groups, trash and journal in a temp dir. Owner and viewer see the same data;
 * the owner gets the commands and the Restore buttons, the others are told who
 * can act.
 */

const NPX = `npx -y mcpcut@${PRODUCT_VERSION}`

let fx: FilesFixture

beforeEach(async () => {
  fx = await makeFixture()
})

afterEach(async () => {
  await fx.cleanup()
})

async function pageFor(role: 'owner' | 'viewer', query = ''): Promise<string> {
  return bodyOf(await fx.handlers().filesPage(getCtx(session(role), query)))
}

describe('the page with data', () => {
  test('shows the four panels in order with the folder, rules, trash entry and audit row', async () => {
    await fx.declareRoot()
    await fx.grantAgent('bot', [{ path: fx.root, ops: ['read', 'write'] }])
    await fx.trashFile('docs/old.txt')
    await fx.writeRecords('s1', [decision({ agent: 'bot', tool: 'read_file', payload: { path: `${fx.root}/docs/a.txt` } })])

    const page = await pageFor('owner')

    const order = ['id="folders"', 'id="access"', 'id="trash"', 'id="audit"'].map((marker) => page.indexOf(marker))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(page).toContain(`<code>${fx.root}</code>`)
    expect(page).toContain('trash ok')
    expect(page).toContain('read, write')
    expect(page).toContain('<code>docs/old.txt</code>')
    expect(page).toContain('read_file')
    expect(page).toContain('/journal?session=s1')
  })

  test('marks a root whose trash folder is gone and names the recreate command', async () => {
    await fx.declareRoot()
    await fx.roots.add(`${fx.root}-gone`)

    const page = await pageFor('owner')

    expect(page).toContain('trash missing')
    expect(page).toContain(`${NPX} files root add ${fx.root}-gone</pre>`)
  })

  test('the Files tab is in the nav for every role', async () => {
    expect(await pageFor('viewer')).toContain('<a class="tab" href="/files" aria-current="page">Files</a>')
    expect(await pageFor('owner')).toContain('<a class="tab" href="/files" aria-current="page">Files</a>')
  })

  test('escapes names that come off disk', async () => {
    await fx.declareRoot()
    await fx.trashFile('<img src=x onerror=alert(1)>.txt')

    const page = await pageFor('owner')

    expect(page).not.toContain('<img src=x')
    expect(page).toContain('&lt;img src=x')
  })
})

describe('access', () => {
  test('shows personal rules, a cut-out, and where inherited rules come from', async () => {
    await fx.declareRoot()
    await fx.grantAgent('bot', [
      { path: fx.root, ops: ['read'] },
      { path: `${fx.root}/secret`, ops: [] },
    ])
    await fx.agents.createAgent('member')
    await fx.groups.createGroup('team')
    await fx.groups.setServerGrant('team', 'files', { tools: '*', paths: [{ path: fx.root, ops: ['read', 'edit'] }] })
    await fx.groups.addMember('team', 'member')

    const page = await pageFor('viewer')

    expect(page).toContain('no access (cut out)')
    expect(page).toContain('from group team')
    expect(page).toContain('members: member')
    expect(page).toContain('read, edit')
  })

  test('an owner gets grant, group grant and revoke commands with the real values', async () => {
    await fx.declareRoot()
    await fx.grantAgent('bot', [{ path: fx.root, ops: ['read'] }])
    await fx.groups.createGroup('team')

    const page = await pageFor('owner')

    expect(page).toContain(`${NPX} files grant bot ${fx.root} --ops read</pre>`)
    expect(page).toContain(`${NPX} files grant --group team ${fx.root} --ops read</pre>`)
    expect(page).toContain(`${NPX} files revoke bot ${fx.root}</pre>`)
  })

  test('quotes a folder with a space in the command', async () => {
    await fx.agents.createAgent('bot')
    await fx.roots.add('/tmp/with space')

    const page = await pageFor('owner')

    expect(page).toContain(`files grant bot &#39;/tmp/with space&#39; --ops read</pre>`)
  })

  test('a viewer is told an owner gives access and gets no command', async () => {
    await fx.declareRoot()
    await fx.grantAgent('bot', [{ path: fx.root, ops: ['read'] }])

    const page = await pageFor('viewer')

    expect(page).toContain('An owner gives access.')
    expect(page).not.toContain('files grant')
  })

  test('with no agent an owner is sent to create one', async () => {
    await fx.declareRoot()

    expect(await pageFor('owner')).toContain('<a href="/agents">Create an agent first</a>')
  })

  test('with no folder an owner is sent to the folders panel', async () => {
    await fx.agents.createAgent('bot')

    expect(await pageFor('owner')).toContain('<a href="#folders">Declare a folder first</a>')
  })

  test('a revoked agent is not listed as holding access', async () => {
    await fx.declareRoot()
    await fx.grantAgent('gone', [{ path: fx.root, ops: ['read'] }])
    await fx.agents.revokeAgent('gone')

    expect(await pageFor('owner')).toContain('No agent or group has folder rules yet.')
  })
})

describe('empty states', () => {
  test('owner with nothing declared: the folder command, the empty trash and the audit next step', async () => {
    const page = await pageFor('owner')

    expect(page).toMatch(/<p class="empty">No folders yet\. Declare one agents may reach:<\/p><pre class="ag-config"[^>]*>[^<]*files root add &lt;folder&gt;<\/pre>/)
    expect(page).toContain('Nothing in the trash. What agents delete stays here for 30 days.')
    expect(page).toContain('No file operations recorded. Declare a folder first:')
  })

  test('viewer with nothing declared is told an owner does it', async () => {
    const page = await pageFor('viewer')

    expect(page).toContain('No folders yet. An owner declares them.')
    expect(page).toContain('An owner declares a folder first.')
    expect(page).not.toContain('files root add')
  })

  test('folders and an agent but no calls: the audit gives the grant command', async () => {
    await fx.declareRoot()
    await fx.agents.createAgent('bot')

    const page = await pageFor('owner')

    expect(page).toContain('No file operations recorded yet.')
    expect(page).toContain(`${NPX} files grant bot ${fx.root} --ops read</pre>`)
  })

  test('filters that match nothing say so', async () => {
    await fx.declareRoot()

    const page = await pageFor('owner', 'agent=nobody')

    expect(page).toContain('No file operations match these filters')
  })
})

describe('trash', () => {
  test('lists newest first with a Restore form per entry for an owner', async () => {
    await fx.declareRoot()
    const older = await fx.trashFile('a.txt')
    const newer = await fx.trashFile('b.txt')

    const page = await pageFor('owner')

    expect(page.indexOf('b.txt')).toBeLessThan(page.indexOf('a.txt'))
    expect(page).toContain('action="/files/trash/restore"')
    expect(page).toContain('name="csrf_token"')
    expect(page).toContain(`name="id" value="${newer}"`)
    expect(page).toContain(`name="id" value="${older}"`)
    expect(page).toContain(`name="root" value="${fx.root}"`)
    expect(page).toContain('Kept 30 days, then removed automatically.')
    expect(page).toContain(`${NPX} files trash purge ${fx.root} --older-than-days 30</pre>`)
  })

  test('a viewer sees the entries but no Restore button or purge command', async () => {
    await fx.declareRoot()
    await fx.trashFile('a.txt')

    const page = await pageFor('viewer')

    expect(page).toContain('a.txt')
    expect(page).toContain('An owner restores.')
    expect(page).not.toContain('action="/files/trash/restore"')
    expect(page).not.toContain('trash purge')
  })

  test('cuts a long trash at 100 and points to the CLI for the rest', async () => {
    await fx.declareRoot()
    for (let index = 0; index < 101; index += 1) {
      const id = ulid(NOW + index)
      await writeManifest(trashDirOf(fx.root), {
        id,
        root: fx.root,
        relative: `f${String(index)}.txt`,
        originalPath: `${fx.root}/f${String(index)}.txt`,
        kind: 'file',
        size: 1,
        deletedAt: new Date(NOW + index).toISOString(),
        deletedBy: 'bot',
      })
    }

    const page = await pageFor('owner')

    expect(page).toContain('and 1 more')
    expect(page).toContain(`${NPX} files trash list ${fx.root}`)
    expect(page).toContain('f100.txt')
    expect(page).not.toContain('<code>f0.txt</code>')
  })

  test('counts an unreadable entry and says how to remove it', async () => {
    await fx.declareRoot()
    await writeFile(join(fx.root, '.mcpcut-trash', '01ARZ3NDEKTSV4RRFFQ69G5FAV.json'), 'not json')

    const page = await pageFor('owner')

    expect(page).toContain('1 unreadable entry skipped')
    expect(page).toContain(`remove by hand inside <code>${fx.root}/.mcpcut-trash</code>`)
  })
})

describe('who touched what', () => {
  test('shows a move as source → destination and a denial with its rule', async () => {
    await fx.declareRoot()
    await fx.writeRecords('s2', [
      decision({ agent: 'bot', tool: 'move_file', payload: { source: `${fx.root}/a`, destination: `${fx.root}/b` } }),
      decision({ ts: '2026-10-04T11:00:00.000Z', agent: 'bot', tool: 'delete_file', outcome: 'deny', rule: 'files: no delete right', payload: { path: `${fx.root}/c` } }),
    ])

    const page = await pageFor('owner')

    expect(page).toContain(`<code>${fx.root}/a → ${fx.root}/b</code>`)
    expect(page).toContain('files: no delete right')
    expect(page.indexOf('delete_file')).toBeLessThan(page.indexOf('move_file'))
  })

  test('shows an admin edit as admin <name> (via)', async () => {
    await fx.declareRoot()
    await fx.writeRecords('plane_access', [
      {
        id: '01ARZ3NDEKTSV4RRFFQ69HZZZZ',
        ts: '2026-10-04T09:00:00.000Z',
        sessionId: 'plane_access',
        direction: 'client→server',
        kind: 'access-edit',
        payload: { action: 'files.grant', path: fx.root, agent: 'bot', actor: { adminName: 'ann', role: 'owner', via: 'cli' } },
      } as never,
    ])

    expect(await pageFor('viewer')).toContain('admin ann (cli)')
  })

  test('the agent select lists known agents and keeps the chosen one', async () => {
    await fx.declareRoot()
    await fx.agents.createAgent('bot')
    await fx.agents.createAgent('other')

    const page = await pageFor('owner', 'agent=other')

    expect(page).toContain('<option value="bot">bot</option>')
    expect(page).toContain('<option value="other" selected>other</option>')
    expect(page).toContain('value="7d"')
  })

  test('a bad since shows the error line with both forms and the rest still renders', async () => {
    await fx.declareRoot()

    const page = await pageFor('owner', 'since=yesterday')

    expect(page).toContain('YYYY-MM-DD')
    expect(page).toContain('7d')
    expect(page).toContain('role="alert"')
    expect(page).toContain('id="folders"')
    expect(page).toContain('id="trash"')
  })

  test('a relative path is refused with a line, not an empty result', async () => {
    await fx.declareRoot()

    expect(await pageFor('owner', 'path=docs')).toContain('Path must be absolute')
  })

  test('filters by agent and path', async () => {
    await fx.declareRoot()
    await fx.writeRecords('s3', [
      decision({ agent: 'bot', payload: { path: `${fx.root}/in/a` } }),
      decision({ agent: 'other', payload: { path: `${fx.root}/in/b` } }),
      decision({ agent: 'bot', payload: { path: `${fx.root}/out/c` } }),
    ])

    const page = await pageFor('owner', `agent=bot&path=${encodeURIComponent(`${fx.root}/in`)}`)

    expect(page).toContain(`<code>${fx.root}/in/a</code>`)
    expect(page).not.toContain(`${fx.root}/in/b`)
    expect(page).not.toContain(`${fx.root}/out/c`)
  })

  test('past 50 rows it points to the full list with the filters filled in', async () => {
    await fx.declareRoot()
    await fx.writeRecords(
      's4',
      Array.from({ length: 51 }, (_unused, index) =>
        decision({ ts: `2026-10-04T10:${String(index).padStart(2, '0')}:00.000Z`, agent: 'bot', payload: { path: `${fx.root}/f${String(index)}` } }),
      ),
    )

    const page = await pageFor('owner', 'agent=bot&since=3d')

    expect(page).toContain('Showing the newest 50')
    expect(page).toContain(`${NPX} files audit --agent bot --since 3d --limit 1000</pre>`)
    expect(statusOf(await fx.handlers().filesPage(getCtx(session('owner'))))).toBe(200)
  })
})

describe('review fixes', () => {
  test('an admin edit in the audit says whom it was for', async () => {
    await fx.declareRoot()
    await fx.writeRecords('plane_access', [
      {
        id: '01ARZ3NDEKTSV4RRFFQ69HZZZY',
        ts: '2026-10-04T09:00:00.000Z',
        sessionId: 'plane_access',
        direction: 'client→server',
        kind: 'access-edit',
        payload: { action: 'files.grant', path: fx.root, group: 'devs', actor: { adminName: 'ann', role: 'owner', via: 'ui' } },
      } as never,
    ])

    expect(await pageFor('viewer')).toContain('for group devs')
  })

  test('every folder with trash gets its own purge command', async () => {
    await fx.declareRoot()
    const second = join(fx.base, 'second')
    await mkdir(second, { recursive: true })
    await fx.roots.add(second)
    await mkdir(join(second, '.mcpcut-trash'), { recursive: true, mode: 0o700 })
    await fx.trashFile('a.txt')
    await writeManifest(trashDirOf(second), {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      root: second,
      relative: 'gone',
      originalPath: join(second, 'gone'),
      kind: 'directory',
      size: 0,
      deletedAt: '2026-10-04T08:00:00.000Z',
      deletedBy: 'bot',
    })

    const page = await pageFor('owner')

    expect(page).toContain(`${NPX} files trash purge ${fx.root} --older-than-days 30</pre>`)
    expect(page).toContain(`${NPX} files trash purge ${second} --older-than-days 30</pre>`)
  })

  test('a trashed folder shows no byte size', async () => {
    await fx.declareRoot()
    await writeManifest(trashDirOf(fx.root), {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
      root: fx.root,
      relative: 'old-folder',
      originalPath: join(fx.root, 'old-folder'),
      kind: 'directory',
      size: 0,
      deletedAt: '2026-10-04T08:00:00.000Z',
      deletedBy: 'bot',
    })

    const page = await pageFor('owner')

    expect(page).toMatch(/<td>folder<\/td>\s*<td class="num">-<\/td>/)
  })

  test('an empty trash with no folder points an owner at the folders panel', async () => {
    const page = await pageFor('owner')

    expect(page).toMatch(/Nothing in the trash\.[^<]*<a href="#folders">/)
  })

  test('a broken folders file answers a notice that names the command to see why', async () => {
    await writeFile(join(fx.journalDir, 'files-roots.json'), '{ not json')

    const result = await fx.handlers().filesPage(getCtx(session('owner')))

    expect(statusOf(result)).toBe(500)
    expect(bodyOf(result)).toContain('files root list')
    expect(bodyOf(result)).not.toContain('not json')
  })

  test('a revoked agent is marked as such among a group\'s members', async () => {
    await fx.declareRoot()
    await fx.agents.createAgent('ann')
    await fx.agents.createAgent('bot')
    await fx.groups.createGroup('devs')
    await fx.groups.addMember('devs', 'ann')
    await fx.groups.addMember('devs', 'bot')
    await fx.groups.setServerGrant('devs', 'files', { tools: '*', paths: [{ path: fx.root, ops: ['read'] }] })
    await fx.agents.revokeAgent('bot')

    const page = await pageFor('viewer')

    expect(page).toContain('members: ann, bot (revoked)')
  })
})

describe('the audit panel when Postgres is turned on but cannot answer', () => {
  test('shows why the journal answered, above the table, and still lists the rows', async () => {
    await fx.declareRoot()
    await fx.writeRecords('s1', [decision({ agent: 'bot', tool: 'read_file', payload: { path: `${fx.root}/docs/a.txt` } })])
    const { createVaultStore } = await import('../../src/vault/store.js')
    await createVaultStore({ journalDir: fx.journalDir }).init()
    await createVaultStore({ journalDir: fx.journalDir }).setSecret('files-pg-url', 'postgres://u:pw-secret@127.0.0.1:1/db')

    const page = await pageFor('owner')

    expect(page).toContain('role="status"')
    expect(page).toContain('Postgres support is not installed: run')
    expect(page).toContain('answered from the journal.')
    expect(page).not.toContain('pw-secret')
    expect(page).toContain('read_file')
  })
})
