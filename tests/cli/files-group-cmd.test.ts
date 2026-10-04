import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { createAgentsStore } from '../../src/agents/store.js'
import { dispatch } from '../../src/cli.js'
import { createGroupsStore } from '../../src/groups/store.js'
import { ACCESS_EDIT_SESSION_ID } from '../../src/journal/access-edit-record.js'
import { readJournalRecords } from '../support/journal-rows.js'

/** `mcpcut files grant|revoke|show --group …` through the dispatcher, on temp dirs only. */

let base: string
let journalDir: string
let root: string
let ownerToken: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'mcpcut-files-group-')))
  journalDir = join(base, 'state')
  await mkdir(journalDir, { recursive: true })
  root = join(base, 'data')
  await mkdir(join(root, 'a'), { recursive: true })
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

async function groupOf(name: string) {
  return createGroupsStore({ journalDir }).getGroup(name)
}

beforeEach(async () => {
  await createGroupsStore({ journalDir }).createGroup('team')
  expect((await files(['root', 'add', root])).code).toBe(0)
})

describe('files grant --group', () => {
  test('stores the rule in the group, prints its rules and names the member agents', async () => {
    const agents = createAgentsStore({ journalDir })
    await agents.createAgent('ann')
    await agents.createAgent('bot')
    const groups = createGroupsStore({ journalDir })
    await groups.addMember('team', 'bot')
    await groups.addMember('team', 'ann')

    const result = await files(['grant', '--group', 'team', join(root, 'a'), '--ops', 'read,write'])

    expect(result.code).toBe(0)
    expect((await groupOf('team'))?.grants['files']).toEqual({ tools: '*', paths: [{ path: join(root, 'a'), ops: ['read', 'write'] }] })
    expect(result.out).toContain(`${join(root, 'a')}: read, write`)
    expect(result.err).toContain('Agents in team get it: ann, bot. Check one: mcpcut files show ann')
    expect(result.err).toContain('[audit] files grant by alice (owner)')
    expect(result.err).toContain('team')
  })

  test('a group without members points at the command that adds one', async () => {
    const result = await files(['grant', '--group', 'team', join(root, 'a'), '--ops', 'read'])

    expect(result.code).toBe(0)
    expect(result.err).toContain('mcpcut group join team <agent>')
  })

  test('journals files.grant with the group and no agent', async () => {
    await files(['grant', '--group', 'team', join(root, 'a'), '--ops', 'read'])

    const last = (await accessPayloads()).at(-1)
    expect(last).toMatchObject({ action: 'files.grant', group: 'team', server: 'files', path: join(root, 'a') })
    expect(last).not.toHaveProperty('agent')
    expect(JSON.stringify(last?.['grant'])).toContain(join(root, 'a'))
  })

  test('keeps the tools of an existing group files grant', async () => {
    await createGroupsStore({ journalDir }).grantServer('team', 'files', ['read_file'])

    await files(['grant', '--group', 'team', join(root, 'a'), '--ops', 'read'])

    expect((await groupOf('team'))?.grants['files']?.tools).toEqual(['read_file'])
  })

  test('an unknown group names the command that lists groups and writes nothing', async () => {
    const result = await files(['grant', '--group', 'ghost', join(root, 'a'), '--ops', 'read'])

    expect(result.code).toBe(1)
    expect(result.err.trim().split('\n')).toHaveLength(1)
    expect(result.err).toContain('mcpcut group list')
    expect(await accessPayloads()).toHaveLength(1)
  })

  test('a path outside the roots is refused and nothing is written', async () => {
    const result = await files(['grant', '--group', 'team', base, '--ops', 'read'])

    expect(result.code).toBe(1)
    expect(result.err).toContain('mcpcut files root add')
    expect((await groupOf('team'))?.grants).toEqual({})
  })

  test('without an owner token nothing changes', async () => {
    const result = await files(['grant', '--group', 'team', join(root, 'a'), '--ops', 'read'], {})

    expect(result.code).toBe(1)
    expect((await groupOf('team'))?.grants).toEqual({})
  })

  test('requires --ops', async () => {
    const result = await files(['grant', '--group', 'team', join(root, 'a')])

    expect(result.code).toBe(1)
    expect(result.err).toContain(`mcpcut files grant --group team ${join(root, 'a')} --ops read`)
  })

  test.each([
    ['two positionals', ['grant', '--group', 'team', 'bot', '/data/a', '--ops', 'read']],
    ['no positional', ['grant', '--group', 'team', '--ops', 'read']],
  ])('%s → usage, exit 1', async (_label, args) => {
    const result = await files(args)

    expect(result.code).toBe(1)
    expect(result.err).toContain('Usage:')
  })

  test('the agent form still needs two positionals', async () => {
    const result = await files(['grant', join(root, 'a'), '--ops', 'read'])

    expect(result.code).toBe(1)
    expect(result.err).toContain('Usage:')
  })
})

describe('files revoke --group', () => {
  beforeEach(async () => {
    await files(['grant', '--group', 'team', join(root, 'a'), '--ops', 'read'])
  })

  test('drops the rule, prints the outcome and journals files.revoke with the group', async () => {
    await createAgentsStore({ journalDir }).createAgent('bot')
    await createGroupsStore({ journalDir }).addMember('team', 'bot')

    const result = await files(['revoke', '--group', 'team', join(root, 'a')])

    expect(result.code).toBe(0)
    expect((await groupOf('team'))?.grants['files']).toEqual({ tools: '*' })
    expect(result.out).toContain('team')
    expect(result.err).toContain('Agents in team get it: bot')
    const last = (await accessPayloads()).at(-1)
    expect(last).toMatchObject({ action: 'files.revoke', group: 'team', server: 'files' })
    expect(last).not.toHaveProperty('agent')
  })

  test('a folder without a rule is a one-line refusal naming files show --group', async () => {
    const result = await files(['revoke', '--group', 'team', join(root, 'zzz')])

    expect(result.code).toBe(1)
    expect(result.err).toContain('mcpcut files show --group team')
  })

  test('an unknown group names the command that lists groups', async () => {
    const result = await files(['revoke', '--group', 'ghost', join(root, 'a')])

    expect(result.code).toBe(1)
    expect(result.err).toContain('mcpcut group list')
  })

  test('two positionals → usage', async () => {
    expect((await files(['revoke', '--group', 'team', 'bot', join(root, 'a')])).code).toBe(1)
  })
})

describe('files show --group', () => {
  test('lists the group rules and its members, no token needed', async () => {
    await createAgentsStore({ journalDir }).createAgent('bot')
    await createGroupsStore({ journalDir }).addMember('team', 'bot')
    await files(['grant', '--group', 'team', join(root, 'a'), '--ops', 'read'])

    const result = await files(['show', '--group', 'team'], {})

    expect(result.code).toBe(0)
    expect(result.out).toContain(`${join(root, 'a')}: read`)
    expect(result.out).toContain('bot')
    expect(result.err).toContain('mcpcut files grant --group team')
  })

  test('empty rules say so and give the grant command', async () => {
    const result = await files(['show', '--group', 'team'], {})

    expect(result.code).toBe(0)
    expect(result.out).toContain('no file access')
    expect(result.err).toContain('mcpcut files grant --group team <folder> --ops read')
  })

  test('an unknown group names the command that lists groups', async () => {
    const result = await files(['show', '--group', 'ghost'], {})

    expect(result.code).toBe(1)
    expect(result.err).toContain('mcpcut group list')
  })

  test('a name together with --group → usage', async () => {
    expect((await files(['show', '--group', 'team', 'bot'], {})).code).toBe(1)
  })
})
