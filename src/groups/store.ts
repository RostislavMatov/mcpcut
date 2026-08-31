import type { z } from 'zod'
import type { MethodGrantsInput } from '../agents/store.js'
import { RESERVED_OBJECT_KEYS } from '../policy/constants.js'
import { createJsonStore, type JsonStore } from '../policy/store.js'
import { GROUP_NAME_PATTERN, groupsFilePath } from './constants.js'
import { assertValidAgentName, assertValidServerName, buildGrant } from './grant-input.js'
import { parseGroupsFile, type GroupRecord, type GroupsFile } from './schema.js'

/**
 * Store for server groups: the `groups.json` document in
 * `<journalDir>/state.db`, built on the transactional `createJsonStore`
 * (0600 file / 0700 dir, SQLite CAS — all inherited), mirroring
 * `agents/store.ts` method for method.
 *
 * A group carries per-server grants (G1) and the names of the agents that
 * inherit them (the G3 refinement: membership lives in the GROUP document, so
 * "a group with members cannot be removed" is decided and written inside ONE
 * CAS cycle of ONE document — two documents in `state.db` do not share a
 * transaction).
 *
 * Like the agents store, this one deliberately has no dependency on the
 * registry or on `agents.json`: whether a granted server or a member agent
 * actually EXISTS is a CLI/UI question (`agents/constants.ts` states the same
 * rule for grants). A corrupt document surfaces as `StoreCorruptError`, never
 * as "no groups" — silently losing every group would silently narrow every
 * agent's access while looking healthy.
 */

/** Raised when creating a group whose name is already taken. */
export class GroupExistsError extends Error {
  constructor(name: string) {
    super(`group "${name}" already exists`)
    this.name = 'GroupExistsError'
  }
}

/** Raised when an operation targets a group that does not exist. */
export class GroupNotFoundError extends Error {
  constructor(name: string) {
    super(`group "${name}" does not exist`)
    this.name = 'GroupNotFoundError'
  }
}

/** Raised for a group name outside `^[a-z0-9][a-z0-9-]{0,63}$` (or a reserved word). */
export class InvalidGroupNameError extends Error {
  constructor(name: string) {
    super(`invalid group name "${name}": must match ${GROUP_NAME_PATTERN.source}`)
    this.name = 'InvalidGroupNameError'
  }
}

/** Thrown by the injected validator; surfaced to callers wrapped in `StoreCorruptError`. */
export class GroupsFileInvalidError extends Error {
  constructor(error: z.ZodError) {
    const details = error.issues
      .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
      .join('; ')
    super(`groups file failed validation: ${details}`)
    this.name = 'GroupsFileInvalidError'
  }
}

/**
 * Result of `removeGroup`. `has-members` is a REFUSAL, not a failure: G3
 * forbids deleting a group somebody still inherits access from, and the
 * caller has to be able to name those members back to the operator.
 */
export type RemoveGroupResult =
  | { readonly status: 'removed'; readonly record: GroupRecord }
  | { readonly status: 'not-found' }
  | { readonly status: 'has-members'; readonly members: readonly string[] }

export interface GroupsStore {
  /** Creates an empty group; rejects with `GroupExistsError` on a duplicate name. */
  createGroup(name: string): Promise<GroupRecord>
  /** Removes by name; never throws for a missing name or a group with members (typed result). */
  removeGroup(name: string): Promise<RemoveGroupResult>
  /**
   * Replaces the group's grant for `server` wholesale (no merging), exactly
   * like `AgentsStore.grantServer`: same input, same validation, same errors.
   * Omitted `methods` fields stay absent in the stored grant, which keeps the
   * fail-closed denial of the corresponding methods.
   */
  grantServer(
    group: string,
    server: string,
    tools: readonly string[] | '*',
    methods?: MethodGrantsInput,
  ): Promise<GroupRecord>
  /** Removes the grant for `server`; idempotent when no such grant exists. */
  ungrantServer(group: string, server: string): Promise<GroupRecord>
  /** Adds an agent to the group; idempotent. Membership stays sorted and unique. */
  addMember(group: string, agent: string): Promise<GroupRecord>
  /** Removes an agent from the group; idempotent. */
  removeMember(group: string, agent: string): Promise<GroupRecord>
  getGroup(name: string): Promise<GroupRecord | undefined>
  /** All groups, sorted by name for stable CLI/UI output. */
  listGroups(): Promise<readonly GroupRecord[]>
  /** The groups `agentName` belongs to, in `listGroups` order. */
  groupsOf(agentName: string): Promise<readonly GroupRecord[]>
  /**
   * Removes the grant for `server` from EVERY group (G6 cascade of
   * `server remove`). Returns the names of the groups that actually held the
   * grant, sorted like `listGroups`; a repeat call returns an empty list.
   */
  ungrantServerEverywhere(server: string): Promise<readonly string[]>
}

export interface GroupsStoreOptions {
  /** Journal directory override; defaults to `JOURNAL_DIR`. */
  readonly journalDir?: string
  /** Clock override for deterministic timestamps in tests. */
  readonly clock?: () => Date
}

const EMPTY_FILE: GroupsFile = { version: 1, groups: {} }

function validateGroupsFile(raw: unknown): GroupsFile {
  const result = parseGroupsFile(raw)
  if (!result.ok) throw new GroupsFileInvalidError(result.error)
  return result.file
}

function assertValidGroupName(name: string): void {
  if (!GROUP_NAME_PATTERN.test(name) || RESERVED_OBJECT_KEYS.includes(name)) {
    throw new InvalidGroupNameError(name)
  }
}

/**
 * `Object.hasOwn` guard for every map lookup: a hostile name such as
 * `__proto__` must read as "absent", not resolve through the prototype chain.
 */
function ownGroup(file: GroupsFile, name: string): GroupRecord | undefined {
  return Object.hasOwn(file.groups, name) ? file.groups[name] : undefined
}

function requireGroup(file: GroupsFile, name: string): GroupRecord {
  const record = ownGroup(file, name)
  if (record === undefined) throw new GroupNotFoundError(name)
  return record
}

/** New file value with `record` upserted under its name (input untouched). */
function withGroup(file: GroupsFile, record: GroupRecord): GroupsFile {
  return { ...file, groups: { ...file.groups, [record.name]: record } }
}

/**
 * `members` with `agent` inserted, kept sorted by UTF-16 code unit (plain
 * comparison, never `localeCompare` — the persisted document must be
 * byte-identical across platforms; `groups/schema.ts` enforces the same
 * order). Returns the SAME array reference when the agent is already a
 * member, which is how the idempotent no-op is detected.
 */
function withMember(members: readonly string[], agent: string): readonly string[] {
  if (members.includes(agent)) return members
  const next = [...members, agent]
  next.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return next
}

export function createGroupsStore(opts: GroupsStoreOptions = {}): GroupsStore {
  const clock = opts.clock ?? (() => new Date())
  const store: JsonStore<GroupsFile> = createJsonStore(groupsFilePath(opts.journalDir), {
    validate: validateGroupsFile,
    defaultValue: EMPTY_FILE,
  })

  async function createGroup(name: string): Promise<GroupRecord> {
    assertValidGroupName(name)
    // `fn` must be pure and re-runnable, so the timestamp is minted BEFORE
    // the update: a `clock()` call inside would hand a retry a different
    // record than the one this call reports.
    const record: GroupRecord = {
      name,
      createdAt: clock().toISOString(),
      grants: {},
      members: [],
    }

    await store.update((current) => {
      if (ownGroup(current, name) !== undefined) throw new GroupExistsError(name)
      return withGroup(current, record)
    })

    return record
  }

  async function removeGroup(name: string): Promise<RemoveGroupResult> {
    // `update` may re-run this callback when it loses the CAS to a concurrent
    // writer, so the captured outcome is reset at the top of EVERY attempt: a
    // first attempt that saw the group, followed by a retry that no longer
    // does, would otherwise report a removal that never happened.
    let outcome: RemoveGroupResult = { status: 'not-found' }
    await store.update((current) => {
      outcome = { status: 'not-found' }
      const existing = ownGroup(current, name)
      if (existing === undefined) return current
      if (existing.members.length > 0) {
        outcome = { status: 'has-members', members: [...existing.members] }
        return current
      }
      outcome = { status: 'removed', record: existing }
      const remaining = Object.fromEntries(
        Object.entries(current.groups).filter(([key]) => key !== name),
      )
      return { ...current, groups: remaining }
    })
    return outcome
  }

  async function grantServer(
    group: string,
    server: string,
    tools: readonly string[] | '*',
    methods: MethodGrantsInput = {},
  ): Promise<GroupRecord> {
    assertValidServerName(server)
    const grant = buildGrant(tools, methods)

    const next = await store.update((current) => {
      const record = requireGroup(current, group)
      return withGroup(current, { ...record, grants: { ...record.grants, [server]: grant } })
    })
    return next.groups[group] as GroupRecord
  }

  async function ungrantServer(group: string, server: string): Promise<GroupRecord> {
    const next = await store.update((current) => {
      const record = requireGroup(current, group)
      const { [server]: _removed, ...remaining } = record.grants
      return withGroup(current, { ...record, grants: remaining })
    })
    return next.groups[group] as GroupRecord
  }

  async function addMember(group: string, agent: string): Promise<GroupRecord> {
    assertValidAgentName(agent)
    const next = await store.update((current) => {
      const record = requireGroup(current, group)
      const members = withMember(record.members, agent)
      if (members === record.members) return current
      return withGroup(current, { ...record, members: [...members] })
    })
    return next.groups[group] as GroupRecord
  }

  async function removeMember(group: string, agent: string): Promise<GroupRecord> {
    assertValidAgentName(agent)
    const next = await store.update((current) => {
      const record = requireGroup(current, group)
      if (!record.members.includes(agent)) return current
      return withGroup(current, {
        ...record,
        members: record.members.filter((member) => member !== agent),
      })
    })
    return next.groups[group] as GroupRecord
  }

  async function getGroup(name: string): Promise<GroupRecord | undefined> {
    return ownGroup(await store.read(), name)
  }

  async function listGroups(): Promise<readonly GroupRecord[]> {
    const file = await store.read()
    return Object.values(file.groups).sort((a, b) => a.name.localeCompare(b.name))
  }

  async function groupsOf(agentName: string): Promise<readonly GroupRecord[]> {
    const groups = await listGroups()
    return groups.filter((group) => group.members.includes(agentName))
  }

  async function ungrantServerEverywhere(server: string): Promise<readonly string[]> {
    // Reset per attempt for the same reason as `removeGroup`: a replayed `fn`
    // must not leave the first attempt's findings standing.
    let affected: string[] = []
    await store.update((current) => {
      affected = []
      const entries = Object.entries(current.groups).map(([key, record]) => {
        if (!Object.hasOwn(record.grants, server)) return [key, record] as const
        affected.push(key)
        const { [server]: _removed, ...remaining } = record.grants
        return [key, { ...record, grants: remaining }] as const
      })
      if (affected.length === 0) return current
      return { ...current, groups: Object.fromEntries(entries) }
    })
    return [...affected].sort((a, b) => a.localeCompare(b))
  }

  return {
    createGroup,
    removeGroup,
    grantServer,
    ungrantServer,
    addMember,
    removeMember,
    getGroup,
    listGroups,
    groupsOf,
    ungrantServerEverywhere,
  }
}
