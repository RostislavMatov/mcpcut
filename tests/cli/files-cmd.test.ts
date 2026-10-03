import { mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { dispatch } from '../../src/cli.js'
import { TRASH_DIR_NAME } from '../../src/files/constants.js'
import { createRootsStore } from '../../src/files/roots-store.js'
import { GROUPS_FILE_NAME } from '../../src/groups/constants.js'
import type { GroupRecord, GroupsFile } from '../../src/groups/schema.js'
import { createGroupsStore } from '../../src/groups/store.js'
import { createJsonStore } from '../../src/policy/store.js'
import { ACCESS_EDIT_SESSION_ID } from '../../src/journal/access-edit-record.js'
import { readJournalRecords } from '../support/journal-rows.js'

/** `mcpcut files …` through the dispatcher, on temp dirs only (never the real ~/.mcpcut). */

let base: string
let journalDir: string
let root: string
let ownerToken: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-files-cmd-')))
  journalDir = join(base, 'state')
  await mkdir(journalDir, { recursive: true })
  root = join(base, 'data')
  await mkdir(join(root, 'a', 'secret'), { recursive: true })
  ownerToken = (await createAdminStore({ journalDir }).createAdmin('alice', 'owner')).token
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
}

async function files(args: string[], env: NodeJS.ProcessEnv = { [ADMIN_TOKEN_ENV_VAR]: ownerToken }): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const io = { stdout: { write: (chunk: string) => out.push(chunk) }, stderr: { write: (chunk: string) => err.push(chunk) } }
  const code = await dispatch(['files', ...args], io, { files: { journalDir, env } })
  return { code, out: out.join(''), err: err.join('') }
}

async function accessPayloads(): Promise<Array<Record<string, unknown>>> {
  return (await readJournalRecords(journalDir, ACCESS_EDIT_SESSION_ID)).map((record) => record.payload as Record<string, unknown>)
}

async function declareRoot(): Promise<void> {
  expect((await files(['root', 'add', root])).code).toBe(0)
}

describe('files root', () => {
  test('list on a fresh install is an empty state with the add command', async () => {
    const result = await files(['root', 'list'])

    expect(result.code).toBe(0)
    expect(result.out + result.err).toContain('mcpcut files root add <folder>')
  })

  test('add creates the trash, saves the canonical path and prints the next step (no agents yet)', async () => {
    const link = join(base, 'link')
    await symlink(root, link)

    const result = await files(['root', 'add', link])

    expect(result.code).toBe(0)
    expect(result.out).toContain(root)
    expect(result.out).toContain(TRASH_DIR_NAME)
    expect(result.err).toContain('mcpcut agent create <name>')
    expect((await stat(join(root, TRASH_DIR_NAME))).isDirectory()).toBe(true)
    expect((await createRootsStore({ journalDir }).list()).map((entry) => entry.path)).toEqual([root])
  })

  test('add with exactly one agent suggests the grant command with its real name and path', async () => {
    await createAgentsStore({ journalDir }).createAgent('writer')

    const result = await files(['root', 'add', root])

    expect(result.err).toContain(`mcpcut files grant writer ${root} --ops read`)
  })

  test('add journals files.root.add and an audit line naming the owner', async () => {
    const result = await files(['root', 'add', root])

    expect(result.err).toContain('[audit]')
    expect(result.err).toContain('alice')
    expect(await accessPayloads()).toEqual([expect.objectContaining({ action: 'files.root.add', path: root })])
  })

  test('add without an owner token is refused and changes nothing', async () => {
    const result = await files(['root', 'add', root], {})

    expect(result.code).toBe(1)
    expect(await createRootsStore({ journalDir }).list()).toEqual([])
    await expect(stat(join(root, TRASH_DIR_NAME))).rejects.toThrow()
  })

  test('add refuses a relative path in one line that says what to do', async () => {
    const result = await files(['root', 'add', 'data'])

    expect(result.code).toBe(1)
    expect(result.err.trim().split('\n')).toHaveLength(1)
    expect(result.err).toContain('absolute')
  })

  test('add of a declared root says so and exits 0', async () => {
    await declareRoot()

    const result = await files(['root', 'add', root])

    expect(result.code).toBe(0)
    expect(result.out).toContain('already')
  })

  test('add refuses a symlinked trash and leaves the root list empty', async () => {
    await symlink(join(base, 'state'), join(root, TRASH_DIR_NAME))

    const result = await files(['root', 'add', root])

    expect(result.code).toBe(1)
    expect(result.err).toContain('symbolic link')
    expect(await createRootsStore({ journalDir }).list()).toEqual([])
  })

  test('list shows each root and whether its trash is present', async () => {
    await declareRoot()
    await rm(join(root, TRASH_DIR_NAME), { recursive: true })

    const missing = await files(['root', 'list'])
    await files(['root', 'add', root]).catch(() => undefined)

    expect(missing.out).toContain(root)
    expect(missing.out).toMatch(/trash missing/)
  })

  test('list shows trash present', async () => {
    await declareRoot()

    const result = await files(['root', 'list'])

    expect(result.out).toMatch(/trash ok/)
    expect(result.err).toContain('mcpcut files grant')
  })

  test('remove drops the root, says files and trash are kept, journals it', async () => {
    await declareRoot()

    const result = await files(['root', 'remove', root])

    expect(result.code).toBe(0)
    expect(result.out).toMatch(/not deleted|kept/)
    expect(await createRootsStore({ journalDir }).list()).toEqual([])
    expect((await stat(join(root, TRASH_DIR_NAME))).isDirectory()).toBe(true)
    expect((await accessPayloads()).map((payload) => payload['action'])).toEqual(['files.root.add', 'files.root.remove'])
  })

  test('remove of an unknown root exits 1 with the list command', async () => {
    const result = await files(['root', 'remove', root])

    expect(result.code).toBe(1)
    expect(result.err).toContain('mcpcut files root list')
  })

  test('root without a subcommand prints usage', async () => {
    const result = await files(['root'])

    expect(result.code).toBe(1)
    expect(result.err).toContain('files root add')
  })
})

describe('files grant', () => {
  beforeEach(async () => {
    await createAgentsStore({ journalDir }).createAgent('writer')
    await declareRoot()
  })

  test('stores the canonical rule in the files grant and prints the rules and next step', async () => {
    const link = join(base, 'link')
    await symlink(root, link)

    const result = await files(['grant', 'writer', join(link, 'a'), '--ops', 'read,write'])

    expect(result.code).toBe(0)
    const grant = (await createAgentsStore({ journalDir }).getAgent('writer'))?.grants['files']
    expect(grant).toEqual({ tools: '*', paths: [{ path: join(root, 'a'), ops: ['read', 'write'] }] })
    expect(result.out).toContain(`${join(root, 'a')}: read, write`)
    expect(result.err).toContain('mcpcut files show writer')
  })

  test('--ops none stores a cut-out and says so', async () => {
    const result = await files(['grant', 'writer', join(root, 'a', 'secret'), '--ops', 'none'])

    expect(result.code).toBe(0)
    expect(result.out).toContain('no access')
    expect((await createAgentsStore({ journalDir }).getAgent('writer'))?.grants['files']?.paths).toEqual([
      { path: join(root, 'a', 'secret'), ops: [] },
    ])
  })

  test('journals files.grant with the rules', async () => {
    await files(['grant', 'writer', join(root, 'a'), '--ops', 'read'])

    const payloads = await accessPayloads()
    const last = payloads[payloads.length - 1]
    expect(last).toMatchObject({ action: 'files.grant', agent: 'writer', server: 'files' })
    expect(JSON.stringify(last)).toContain(join(root, 'a'))
  })

  test('requires --ops with a ready example', async () => {
    const result = await files(['grant', 'writer', join(root, 'a')])

    expect(result.code).toBe(1)
    expect(result.err).toContain('--ops')
    expect(result.err).toContain(`mcpcut files grant writer ${join(root, 'a')} --ops read`)
  })

  test('rejects an unknown op in one line', async () => {
    const result = await files(['grant', 'writer', join(root, 'a'), '--ops', 'read,fly'])

    expect(result.code).toBe(1)
    expect(result.err).toContain('fly')
    expect(result.err.trim().split('\n')).toHaveLength(1)
  })

  test('unknown agent points at agent list', async () => {
    const result = await files(['grant', 'ghost', join(root, 'a'), '--ops', 'read'])

    expect(result.code).toBe(1)
    expect(result.err).toContain('mcpcut agent list')
  })

  test('a path outside the roots is refused with the root add command and nothing is written', async () => {
    const result = await files(['grant', 'writer', base, '--ops', 'read'])

    expect(result.code).toBe(1)
    expect(result.err).toContain('mcpcut files root add')
    expect((await createAgentsStore({ journalDir }).getAgent('writer'))?.grants).toEqual({})
  })

  test('without an owner token nothing changes', async () => {
    const result = await files(['grant', 'writer', join(root, 'a'), '--ops', 'read'], {})

    expect(result.code).toBe(1)
    expect((await createAgentsStore({ journalDir }).getAgent('writer'))?.grants).toEqual({})
  })

  test('re-granting the same path replaces the rule', async () => {
    await files(['grant', 'writer', join(root, 'a'), '--ops', 'read'])
    await files(['grant', 'writer', join(root, 'a'), '--ops', 'read,delete'])

    expect((await createAgentsStore({ journalDir }).getAgent('writer'))?.grants['files']?.paths).toEqual([
      { path: join(root, 'a'), ops: ['read', 'delete'] },
    ])
  })
})

describe('files revoke', () => {
  beforeEach(async () => {
    await createAgentsStore({ journalDir }).createAgent('writer')
    await declareRoot()
    await files(['grant', 'writer', join(root, 'a'), '--ops', 'read'])
  })

  test('removes the rule, says the agent has no file access now, journals it', async () => {
    const result = await files(['revoke', 'writer', join(root, 'a')])

    expect(result.code).toBe(0)
    expect(result.out).toContain('no file access')
    expect((await createAgentsStore({ journalDir }).getAgent('writer'))?.grants['files']).toEqual({ tools: '*' })
    expect((await accessPayloads()).map((payload) => payload['action'])).toContain('files.revoke')
    expect(result.err).toContain('mcpcut files grant writer')
  })

  test('a rule that does not exist exits 1 pointing at files show', async () => {
    const result = await files(['revoke', 'writer', join(root, 'b')])

    expect(result.code).toBe(1)
    expect(result.err).toContain('mcpcut files show writer')
  })

  test('unknown agent points at agent list', async () => {
    const result = await files(['revoke', 'ghost', join(root, 'a')])

    expect(result.code).toBe(1)
    expect(result.err).toContain('mcpcut agent list')
  })
})

describe('files show', () => {
  test('an agent without rules gets an empty state with the grant command', async () => {
    await createAgentsStore({ journalDir }).createAgent('writer')

    const result = await files(['show', 'writer'])

    expect(result.code).toBe(0)
    expect(result.out).toContain('no file access')
    expect(result.err + result.out).toContain('mcpcut files grant writer <folder> --ops read')
  })

  test('lists the personal rules', async () => {
    await createAgentsStore({ journalDir }).createAgent('writer')
    await declareRoot()
    await files(['grant', 'writer', join(root, 'a'), '--ops', 'read'])

    const result = await files(['show', 'writer'])

    expect(result.out).toContain(`${join(root, 'a')}: read`)
  })

  test('marks rules inherited through a group', async () => {
    await createAgentsStore({ journalDir }).createAgent('writer')
    const groups = createGroupsStore({ journalDir })
    await groups.createGroup('team')
    await groups.addMember('team', 'writer')
    await groups.grantServer('team', 'files', '*')
    // The group store has no folder-rule writer yet: patch the document the way a hand edit would.
    await createJsonStore<GroupsFile>(join(journalDir, GROUPS_FILE_NAME), {
      validate: (raw) => raw as GroupsFile,
      defaultValue: { version: 1, groups: {} } as GroupsFile,
    }).update((current) => {
      const group = current.groups['team'] as GroupRecord
      return { ...current, groups: { team: { ...group, grants: { files: { tools: '*', paths: [{ path: root, ops: ['read'] }] } } } } }
    })

    const result = await files(['show', 'writer'])

    expect(result.out).toContain(`${root}: read`)
    expect(result.out).toContain('group:team')
  })

  test('unknown agent points at agent list', async () => {
    const result = await files(['show', 'ghost'])

    expect(result.code).toBe(1)
    expect(result.err).toContain('mcpcut agent list')
  })
})

describe('files usage', () => {
  test('an unknown subcommand prints usage with exit 1', async () => {
    const result = await files(['frobnicate'])

    expect(result.code).toBe(1)
    expect(result.err).toContain('files root add')
  })

  test('mcpcut --help lists the files command and files --help shows its rows', async () => {
    const help = await files(['--help'])

    expect(help.code).toBe(0)
    expect(help.out).toContain('mcpcut files grant')
  })
})
