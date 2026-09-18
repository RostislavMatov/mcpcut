import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  InvalidAgentNameError,
  InvalidPromptPatternError,
  InvalidResourcePatternError,
  InvalidServerNameError,
  InvalidToolPatternError,
} from '../../src/agents/store.js'
import {
  createGroupsStore,
  GroupExistsError,
  GroupNotFoundError,
  InvalidGroupNameError,
  type GroupsStore,
} from '../../src/groups/store.js'
import { MAX_GROUPS, MAX_MEMBERS_PER_GROUP } from '../../src/groups/constants.js'
import { StoreCorruptError, StoreWriteRejectedError } from '../../src/policy/store.js'

let journalDir: string
let store: GroupsStore

const FIXED_NOW = new Date('2026-08-31T12:00:00.000Z')

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-groups-store-'))
  store = createGroupsStore({ journalDir, clock: () => FIXED_NOW })
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

describe('createGroup', () => {
  test('returns a record with the clock timestamp, no grants and no members', async () => {
    const record = await store.createGroup('analytics')

    expect(record).toEqual({
      name: 'analytics',
      createdAt: FIXED_NOW.toISOString(),
      grants: {},
      members: [],
    })
    expect(await store.getGroup('analytics')).toEqual(record)
  })

  test('persists to <journalDir>/state.db with 0600 permissions', async () => {
    await store.createGroup('analytics')

    const fileStat = await stat(join(journalDir, 'state.db'))

    expect(fileStat.mode & 0o777).toBe(0o600)
  })

  test('duplicate name → GroupExistsError, first record untouched', async () => {
    const first = await store.createGroup('analytics')

    await expect(store.createGroup('analytics')).rejects.toBeInstanceOf(GroupExistsError)
    expect(await store.getGroup('analytics')).toEqual(first)
  })

  test.each(['Analytics', '-bad', '', 'x'.repeat(65), 'with space', '__proto__', 'constructor', 'prototype'])(
    'invalid or reserved name %j → InvalidGroupNameError',
    async (name) => {
      await expect(store.createGroup(name)).rejects.toBeInstanceOf(InvalidGroupNameError)
      expect(await store.listGroups()).toEqual([])
    },
  )
})

describe('removeGroup', () => {
  test('removes an empty group and returns the removed record', async () => {
    const record = await store.createGroup('analytics')

    expect(await store.removeGroup('analytics')).toEqual({ status: 'removed', record })
    expect(await store.getGroup('analytics')).toBeUndefined()
  })

  test('an unknown group is a typed not-found, not a throw', async () => {
    expect(await store.removeGroup('nope')).toEqual({ status: 'not-found' })
  })

  test('a group with members is refused, listing the members (G3)', async () => {
    await store.createGroup('analytics')
    await store.addMember('analytics', 'bot-b')
    await store.addMember('analytics', 'bot-a')

    const result = await store.removeGroup('analytics')

    expect(result).toEqual({ status: 'has-members', members: ['bot-a', 'bot-b'] })
    expect(await store.getGroup('analytics')).toBeDefined()
  })

  test('a hostile name reads as absent, never through the prototype chain', async () => {
    expect(await store.removeGroup('__proto__')).toEqual({ status: 'not-found' })
  })
})

describe('grantServer', () => {
  test('stores a tools-only grant and leaves resources/prompts absent (fail-closed)', async () => {
    await store.createGroup('analytics')

    const record = await store.grantServer('analytics', 'postgres', ['get_*', 'list_tables'])

    expect(record.grants).toEqual({ postgres: { tools: ['get_*', 'list_tables'] } })
    expect(Object.hasOwn(record.grants['postgres'] ?? {}, 'resources')).toBe(false)
  })

  test("tools '*' plus the methods dimension are stored verbatim", async () => {
    await store.createGroup('analytics')

    const record = await store.grantServer('analytics', 'postgres', '*', {
      resources: ['db://tables/*'],
      prompts: '*',
    })

    expect(record.grants['postgres']).toEqual({
      tools: '*',
      resources: ['db://tables/*'],
      prompts: '*',
    })
  })

  test('replaces an existing grant wholesale (no merging)', async () => {
    await store.createGroup('analytics')
    await store.grantServer('analytics', 'postgres', '*', { resources: '*' })

    const record = await store.grantServer('analytics', 'postgres', ['read_only'])

    expect(record.grants['postgres']).toEqual({ tools: ['read_only'] })
  })

  test('other groups and other servers are untouched', async () => {
    await store.createGroup('analytics')
    await store.createGroup('reporting')
    await store.grantServer('analytics', 'clickhouse', '*')
    const reporting = await store.getGroup('reporting')

    await store.grantServer('analytics', 'postgres', ['x'])

    const analytics = await store.getGroup('analytics')
    expect(Object.keys(analytics?.grants ?? {}).sort()).toEqual(['clickhouse', 'postgres'])
    expect(await store.getGroup('reporting')).toEqual(reporting)
  })

  test('an unknown group → GroupNotFoundError', async () => {
    await expect(store.grantServer('nope', 'postgres', '*')).rejects.toBeInstanceOf(
      GroupNotFoundError,
    )
  })

  test.each(['Bad', 'with space', '__proto__'])(
    'invalid server name %j → InvalidServerNameError (before any write)',
    async (server) => {
      await store.createGroup('analytics')

      await expect(store.grantServer('analytics', server, '*')).rejects.toBeInstanceOf(
        InvalidServerNameError,
      )
      expect((await store.getGroup('analytics'))?.grants).toEqual({})
    },
  )

  test.each(['a**', '*mid*', '__proto__'])(
    'invalid tool pattern %j → InvalidToolPatternError',
    async (pattern) => {
      await store.createGroup('analytics')

      await expect(
        store.grantServer('analytics', 'postgres', [pattern]),
      ).rejects.toBeInstanceOf(InvalidToolPatternError)
    },
  )

  test('invalid resource pattern → InvalidResourcePatternError', async () => {
    await store.createGroup('analytics')

    await expect(
      store.grantServer('analytics', 'postgres', '*', { resources: ['has space'] }),
    ).rejects.toBeInstanceOf(InvalidResourcePatternError)
  })

  test('invalid prompt pattern → InvalidPromptPatternError', async () => {
    await store.createGroup('analytics')

    await expect(
      store.grantServer('analytics', 'postgres', '*', { prompts: ['a**'] }),
    ).rejects.toBeInstanceOf(InvalidPromptPatternError)
  })

  test('the caller\'s arrays are copied, not aliased', async () => {
    await store.createGroup('analytics')
    const tools = ['get_a']

    await store.grantServer('analytics', 'postgres', tools)
    tools.push('get_b')

    expect((await store.getGroup('analytics'))?.grants['postgres']?.tools).toEqual(['get_a'])
  })
})

describe('ungrantServer', () => {
  test('removes the grant and reports it as removed', async () => {
    // Arrange
    await store.createGroup('analytics')
    await store.grantServer('analytics', 'postgres', '*')

    // Act
    const result = await store.ungrantServer('analytics', 'postgres')

    // Assert
    expect(result.status).toBe('removed')
    expect(result.status === 'removed' ? result.record.grants : undefined).toEqual({})
  })

  test('a repeat reports absent instead of committing an unchanged document', async () => {
    // Arrange — the caller writes an `access-edit` record off this verdict, so
    // "nothing was there" must be distinguishable from "a grant was dropped".
    await store.createGroup('analytics')
    await store.grantServer('analytics', 'postgres', '*')
    await store.ungrantServer('analytics', 'postgres')

    // Act
    const result = await store.ungrantServer('analytics', 'postgres')

    // Assert
    expect(result.status).toBe('absent')
  })

  test('a server the group never granted reports absent', async () => {
    // Arrange
    await store.createGroup('analytics')

    // Act
    const result = await store.ungrantServer('analytics', 'postgres')

    // Assert
    expect(result.status).toBe('absent')
  })

  test.each(['Postgres', 'with space', '__proto__', 'constructor', ''])(
    'invalid server name %j → InvalidServerNameError, like grantServer',
    async (server) => {
      // Arrange
      await store.createGroup('analytics')

      // Act + Assert
      await expect(store.ungrantServer('analytics', server)).rejects.toBeInstanceOf(
        InvalidServerNameError,
      )
    },
  )

  test('an unknown group → GroupNotFoundError', async () => {
    await expect(store.ungrantServer('nope', 'postgres')).rejects.toBeInstanceOf(GroupNotFoundError)
  })
})

describe('addMember / removeMember', () => {
  test('members are kept sorted by code unit regardless of insertion order', async () => {
    await store.createGroup('analytics')

    await store.addMember('analytics', 'bot-z')
    await store.addMember('analytics', 'bot-a')
    const record = await store.addMember('analytics', 'bot-m')

    expect(record.members).toEqual(['bot-a', 'bot-m', 'bot-z'])
  })

  test('addMember is idempotent: a repeat keeps one entry', async () => {
    await store.createGroup('analytics')
    await store.addMember('analytics', 'bot-a')

    const record = await store.addMember('analytics', 'bot-a')

    expect(record.members).toEqual(['bot-a'])
  })

  test('removeMember drops the member and reports it as removed', async () => {
    // Arrange
    await store.createGroup('analytics')
    await store.addMember('analytics', 'bot-a')
    await store.addMember('analytics', 'bot-b')

    // Act
    const result = await store.removeMember('analytics', 'bot-a')

    // Assert
    expect(result.status).toBe('removed')
    expect(result.status === 'removed' ? result.record.members : undefined).toEqual(['bot-b'])
  })

  test('removeMember on a non-member reports absent instead of writing', async () => {
    // Arrange
    await store.createGroup('analytics')
    await store.addMember('analytics', 'bot-b')

    // Act
    const first = await store.removeMember('analytics', 'bot-a')
    const second = await store.removeMember('analytics', 'bot-b')
    const third = await store.removeMember('analytics', 'bot-b')

    // Assert
    expect(first.status).toBe('absent')
    expect(second.status).toBe('removed')
    expect(third.status).toBe('absent')
  })

  test.each(['Bot', 'with space', '__proto__', ''])(
    'invalid agent name %j → InvalidAgentNameError on both sides',
    async (agent) => {
      await store.createGroup('analytics')

      await expect(store.addMember('analytics', agent)).rejects.toBeInstanceOf(
        InvalidAgentNameError,
      )
      await expect(store.removeMember('analytics', agent)).rejects.toBeInstanceOf(
        InvalidAgentNameError,
      )
    },
  )

  test('an unknown group → GroupNotFoundError on both sides', async () => {
    await expect(store.addMember('nope', 'bot-a')).rejects.toBeInstanceOf(GroupNotFoundError)
    await expect(store.removeMember('nope', 'bot-a')).rejects.toBeInstanceOf(GroupNotFoundError)
  })

  test('the store does NOT check that the agent exists (CLI/UI do)', async () => {
    await store.createGroup('analytics')

    const record = await store.addMember('analytics', 'never-created')

    expect(record.members).toEqual(['never-created'])
  })
})

describe('getGroup / listGroups / groupsOf', () => {
  test('an empty store lists nothing and resolves no group', async () => {
    expect(await store.listGroups()).toEqual([])
    expect(await store.getGroup('analytics')).toBeUndefined()
  })

  test('a hostile name reads as absent, never through the prototype chain', async () => {
    expect(await store.getGroup('__proto__')).toBeUndefined()
    expect(await store.getGroup('constructor')).toBeUndefined()
  })

  test('listGroups is sorted by name', async () => {
    await store.createGroup('reporting')
    await store.createGroup('analytics')

    expect((await store.listGroups()).map((group) => group.name)).toEqual([
      'analytics',
      'reporting',
    ])
  })

  test('groupsOf returns only the groups the agent belongs to, in listGroups order', async () => {
    await store.createGroup('reporting')
    await store.createGroup('analytics')
    await store.createGroup('ops')
    await store.addMember('analytics', 'bot-a')
    await store.addMember('reporting', 'bot-a')
    await store.addMember('ops', 'bot-b')

    expect((await store.groupsOf('bot-a')).map((group) => group.name)).toEqual([
      'analytics',
      'reporting',
    ])
    expect(await store.groupsOf('bot-c')).toEqual([])
  })

  test('state survives a fresh store instance over the same journal dir', async () => {
    await store.createGroup('analytics')
    await store.grantServer('analytics', 'postgres', ['get_*'])
    await store.addMember('analytics', 'bot-a')

    const reopened = createGroupsStore({ journalDir })

    expect(await reopened.getGroup('analytics')).toEqual({
      name: 'analytics',
      createdAt: FIXED_NOW.toISOString(),
      grants: { postgres: { tools: ['get_*'] } },
      members: ['bot-a'],
    })
  })
})

describe('ungrantServerEverywhere', () => {
  test('removes the server from every group and returns the affected names, sorted', async () => {
    await store.createGroup('reporting')
    await store.createGroup('analytics')
    await store.createGroup('ops')
    await store.grantServer('analytics', 'postgres', '*')
    await store.grantServer('reporting', 'postgres', ['get_*'])
    await store.grantServer('ops', 'clickhouse', '*')
    const opsBefore = await store.getGroup('ops')

    const affected = await store.ungrantServerEverywhere('postgres')

    expect(affected).toEqual(['analytics', 'reporting'])
    expect((await store.getGroup('analytics'))?.grants).toEqual({})
    expect((await store.getGroup('reporting'))?.grants).toEqual({})
    expect(await store.getGroup('ops')).toEqual(opsBefore)
  })

  test('a repeat call is idempotent and reports nothing affected', async () => {
    await store.createGroup('analytics')
    await store.grantServer('analytics', 'postgres', '*')
    await store.ungrantServerEverywhere('postgres')

    expect(await store.ungrantServerEverywhere('postgres')).toEqual([])
  })

  test('members are left alone', async () => {
    await store.createGroup('analytics')
    await store.addMember('analytics', 'bot-a')
    await store.grantServer('analytics', 'postgres', '*')

    await store.ungrantServerEverywhere('postgres')

    expect((await store.getGroup('analytics'))?.members).toEqual(['bot-a'])
  })

  test('an unknown server touches nothing', async () => {
    await store.createGroup('analytics')
    await store.grantServer('analytics', 'postgres', '*')
    const before = await store.listGroups()

    expect(await store.ungrantServerEverywhere('never-registered')).toEqual([])
    expect(await store.listGroups()).toEqual(before)
  })
})

describe('schema caps are enforced at write time', () => {
  test(`group number ${MAX_GROUPS + 1} is refused and the document stays readable`, async () => {
    // Arrange — fill the document to the cap.
    for (let index = 0; index < MAX_GROUPS; index += 1) {
      await store.createGroup(`g-${String(index).padStart(4, '0')}`)
    }

    // Act
    const refused = store.createGroup('one-too-many')

    // Assert — refused BEFORE the write, so `groups.json` is still a document
    // every later read (every authentication, in `serve`) can parse.
    await expect(refused).rejects.toBeInstanceOf(StoreWriteRejectedError)
    await expect(refused).rejects.not.toBeInstanceOf(StoreCorruptError)
    expect((await store.listGroups()).length).toBe(MAX_GROUPS)
    expect(await store.getGroup('one-too-many')).toBeUndefined()
  })

  test(`member number ${MAX_MEMBERS_PER_GROUP + 1} is refused and the group stays readable`, async () => {
    // Arrange
    await store.createGroup('analytics')
    for (let index = 0; index < MAX_MEMBERS_PER_GROUP; index += 1) {
      await store.addMember('analytics', `a-${String(index).padStart(4, '0')}`)
    }

    // Act
    const refused = store.addMember('analytics', 'one-too-many')

    // Assert
    await expect(refused).rejects.toBeInstanceOf(StoreWriteRejectedError)
    const record = await store.getGroup('analytics')
    expect(record?.members.length).toBe(MAX_MEMBERS_PER_GROUP)
    expect(record?.members).not.toContain('one-too-many')
    expect((await store.listGroups()).length).toBe(1)
  })
})
