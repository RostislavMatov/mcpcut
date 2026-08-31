import { join } from 'node:path'
import { z } from 'zod'
import { JOURNAL_DIR } from '../config.js'
import { RESERVED_OBJECT_KEYS, TOOL_RULE_NAME_PATTERN } from '../policy/constants.js'
import { createJsonStore, type JsonStore } from '../policy/store.js'
import {
  AGENT_NAME_PATTERN,
  AGENTS_FILE_NAME,
  GRANT_SERVER_NAME_PATTERN,
} from './constants.js'
import { MAX_RESOURCE_PATTERN_CHARS, RESOURCE_GRANT_PATTERN } from './method-grants.js'
import { parseAgentsFile, type AgentGrant, type AgentRecord, type AgentsFile } from './schema.js'
import { generateToken, verifyToken } from './tokens.js'

/**
 * CLI-managed store for agent identities and their grant matrix, backed by
 * `<journalDir>/agents.json` via `createJsonStore` (atomic tmp+rename,
 * cross-process lock, 0600/0700 — the same trust level as the journal).
 *
 * Only token HASHES are ever persisted; the plaintext token exists once, in
 * `createAgent`'s return value.
 */

/** Raised when creating an agent whose name is already taken. */
export class AgentExistsError extends Error {
  constructor(name: string) {
    super(`agent "${name}" already exists`)
    this.name = 'AgentExistsError'
  }
}

/** Raised when an operation targets an agent that does not exist. */
export class AgentNotFoundError extends Error {
  constructor(name: string) {
    super(`agent "${name}" does not exist`)
    this.name = 'AgentNotFoundError'
  }
}

/** Raised for an agent name outside `^[a-z0-9][a-z0-9-]{0,63}$` (or a reserved word). */
export class InvalidAgentNameError extends Error {
  constructor(name: string) {
    super(`invalid agent name "${name}": must match ^[a-z0-9][a-z0-9-]{0,63}$`)
    this.name = 'InvalidAgentNameError'
  }
}

/** Raised for a grant server name outside the registry name format (or a reserved word). */
export class InvalidServerNameError extends Error {
  constructor(server: string) {
    super(`invalid server name "${server}": must match ^[a-z0-9][a-z0-9-]{0,63}$`)
    this.name = 'InvalidServerNameError'
  }
}

/** Raised for a tool pattern that is not an exact name or single trailing-`*` prefix. */
export class InvalidToolPatternError extends Error {
  constructor(pattern: string) {
    super(`invalid tool pattern "${pattern}": must be an exact name or end with a single "*"`)
    this.name = 'InvalidToolPatternError'
  }
}

/** Raised for a resource URI pattern outside `RESOURCE_GRANT_PATTERN` (M4 Task 6). */
export class InvalidResourcePatternError extends Error {
  constructor(pattern: string) {
    super(
      `invalid resource pattern "${pattern}": must be an exact URI or end with a single "*" (no whitespace)`,
    )
    this.name = 'InvalidResourcePatternError'
  }
}

/** Raised for a prompt name pattern that is not an exact name or single trailing-`*` prefix. */
export class InvalidPromptPatternError extends Error {
  constructor(pattern: string) {
    super(`invalid prompt pattern "${pattern}": must be an exact name or end with a single "*"`)
    this.name = 'InvalidPromptPatternError'
  }
}

/** Thrown by the injected validator; surfaced to callers wrapped in `StoreCorruptError`. */
export class AgentsFileInvalidError extends Error {
  constructor(error: z.ZodError) {
    const details = error.issues
      .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
      .join('; ')
    super(`agents file failed validation: ${details}`)
    this.name = 'AgentsFileInvalidError'
  }
}

/** Result of `createAgent`: the persisted record plus the ONE-TIME plaintext token. */
export interface CreatedAgent {
  readonly agent: AgentRecord
  /** Shown to the operator exactly once; unrecoverable afterwards. */
  readonly token: string
}

export interface AgentsStore {
  /** Creates an agent; rejects with `AgentExistsError` on a duplicate name. */
  createAgent(name: string): Promise<CreatedAgent>
  /** Marks the agent revoked. Idempotent: a repeat revoke keeps the original date. */
  revokeAgent(name: string): Promise<AgentRecord>
  /**
   * Replaces the agent's grant for `server` wholesale (no merging). The
   * optional `methods` argument (M4 Task 6) carries the resources/prompts
   * dimension; omitted fields stay absent in the stored grant, which keeps
   * the M3 fail-closed denial of the corresponding methods.
   */
  grantServer(
    agentName: string,
    serverName: string,
    tools: readonly string[] | '*',
    methods?: MethodGrantsInput,
  ): Promise<AgentRecord>
  /** Removes the grant for `server`; idempotent when no such grant exists. */
  ungrantServer(agentName: string, serverName: string): Promise<AgentRecord>
  /**
   * Removes the grant for `server` from EVERY agent record — revoked agents
   * included, since a grant left behind by a removed server would come back
   * to life under a server registered again under the same name. Returns the
   * names of the agents that actually held the grant, sorted like
   * `listAgents`; a repeat call returns an empty list.
   */
  ungrantServerEverywhere(server: string): Promise<readonly string[]>
  getAgent(name: string): Promise<AgentRecord | undefined>
  /** All agents, sorted by name for stable CLI output. */
  listAgents(): Promise<readonly AgentRecord[]>
  /**
   * Resolves a bearer token to its agent via hash comparison
   * (`timingSafeEqual`). A revoked agent resolves to `undefined`, exactly
   * like a token that never existed — callers cannot distinguish the two.
   */
  findAgentByToken(token: string): Promise<AgentRecord | undefined>
}

export interface AgentsStoreOptions {
  /** Journal directory override; defaults to `JOURNAL_DIR`. */
  readonly journalDir?: string
  /** Clock override for deterministic timestamps in tests. */
  readonly clock?: () => Date
}

const EMPTY_FILE: AgentsFile = { version: 1, agents: {} }

function validateAgentsFile(raw: unknown): AgentsFile {
  const result = parseAgentsFile(raw)
  if (!result.ok) throw new AgentsFileInvalidError(result.error)
  return result.file
}

function assertValidAgentName(name: string): void {
  if (!AGENT_NAME_PATTERN.test(name) || RESERVED_OBJECT_KEYS.includes(name)) {
    throw new InvalidAgentNameError(name)
  }
}

function assertValidServerName(server: string): void {
  if (!GRANT_SERVER_NAME_PATTERN.test(server) || RESERVED_OBJECT_KEYS.includes(server)) {
    throw new InvalidServerNameError(server)
  }
}

function assertValidToolPatterns(tools: readonly string[]): void {
  for (const pattern of tools) {
    if (!TOOL_RULE_NAME_PATTERN.test(pattern) || RESERVED_OBJECT_KEYS.includes(pattern)) {
      throw new InvalidToolPatternError(pattern)
    }
  }
}

/** The optional resources/prompts dimension of one grant (M4 Task 6). */
export interface MethodGrantsInput {
  readonly resources?: '*' | readonly string[]
  readonly prompts?: '*' | readonly string[]
}

function assertValidResourcePatterns(patterns: readonly string[]): void {
  for (const pattern of patterns) {
    if (
      pattern.length > MAX_RESOURCE_PATTERN_CHARS ||
      !RESOURCE_GRANT_PATTERN.test(pattern) ||
      RESERVED_OBJECT_KEYS.includes(pattern)
    ) {
      throw new InvalidResourcePatternError(pattern)
    }
  }
}

function assertValidPromptPatterns(patterns: readonly string[]): void {
  for (const pattern of patterns) {
    if (!TOOL_RULE_NAME_PATTERN.test(pattern) || RESERVED_OBJECT_KEYS.includes(pattern)) {
      throw new InvalidPromptPatternError(pattern)
    }
  }
}

/** New file value with `record` upserted under its name (input untouched). */
function withAgent(file: AgentsFile, record: AgentRecord): AgentsFile {
  return { ...file, agents: { ...file.agents, [record.name]: record } }
}

function requireAgent(file: AgentsFile, name: string): AgentRecord {
  const record = Object.hasOwn(file.agents, name) ? file.agents[name] : undefined
  if (record === undefined) throw new AgentNotFoundError(name)
  return record
}

export function createAgentsStore(opts: AgentsStoreOptions = {}): AgentsStore {
  const journalDir = opts.journalDir ?? JOURNAL_DIR
  const clock = opts.clock ?? (() => new Date())
  const store: JsonStore<AgentsFile> = createJsonStore(join(journalDir, AGENTS_FILE_NAME), {
    validate: validateAgentsFile,
    defaultValue: EMPTY_FILE,
  })

  async function createAgent(name: string): Promise<CreatedAgent> {
    assertValidAgentName(name)
    const { token, hash } = generateToken()
    const record: AgentRecord = {
      name,
      tokenHash: hash,
      createdAt: clock().toISOString(),
      grants: {},
    }

    await store.update((current) => {
      if (Object.hasOwn(current.agents, name)) throw new AgentExistsError(name)
      return withAgent(current, record)
    })

    return { agent: record, token }
  }

  async function revokeAgent(name: string): Promise<AgentRecord> {
    const next = await store.update((current) => {
      const record = requireAgent(current, name)
      if (record.revokedAt !== undefined) return current
      return withAgent(current, { ...record, revokedAt: clock().toISOString() })
    })
    return next.agents[name] as AgentRecord
  }

  async function grantServer(
    agentName: string,
    serverName: string,
    tools: readonly string[] | '*',
    methods: MethodGrantsInput = {},
  ): Promise<AgentRecord> {
    assertValidServerName(serverName)
    if (tools !== '*') assertValidToolPatterns(tools)
    if (methods.resources !== undefined && methods.resources !== '*') {
      assertValidResourcePatterns(methods.resources)
    }
    if (methods.prompts !== undefined && methods.prompts !== '*') {
      assertValidPromptPatterns(methods.prompts)
    }
    const grant: AgentGrant = {
      tools: tools === '*' ? '*' : [...tools],
      ...(methods.resources !== undefined
        ? { resources: methods.resources === '*' ? ('*' as const) : [...methods.resources] }
        : {}),
      ...(methods.prompts !== undefined
        ? { prompts: methods.prompts === '*' ? ('*' as const) : [...methods.prompts] }
        : {}),
    }

    const next = await store.update((current) => {
      const record = requireAgent(current, agentName)
      return withAgent(current, {
        ...record,
        grants: { ...record.grants, [serverName]: grant },
      })
    })
    return next.agents[agentName] as AgentRecord
  }

  async function ungrantServer(agentName: string, serverName: string): Promise<AgentRecord> {
    const next = await store.update((current) => {
      const record = requireAgent(current, agentName)
      const { [serverName]: _removed, ...remaining } = record.grants
      return withAgent(current, { ...record, grants: remaining })
    })
    return next.agents[agentName] as AgentRecord
  }

  async function ungrantServerEverywhere(server: string): Promise<readonly string[]> {
    assertValidServerName(server)
    // `update` may re-run this callback when a concurrent process steals the
    // store lock, so the captured result must be reset at the top of EVERY
    // attempt: names collected by an attempt whose CAS then lost would
    // otherwise report a cascade that never reached the file.
    let affected: string[] = []
    await store.update((current) => {
      affected = []
      const agents: Record<string, AgentRecord> = {}
      for (const [name, record] of Object.entries(current.agents)) {
        if (!Object.hasOwn(record.grants, server)) {
          // Carried over as-is: an untouched record must stay byte-for-byte
          // what it was, so nothing here rebuilds it.
          agents[name] = record
          continue
        }
        affected.push(record.name)
        const { [server]: _removed, ...remaining } = record.grants
        agents[name] = { ...record, grants: remaining }
      }
      return affected.length === 0 ? current : { ...current, agents }
    })
    return [...affected].sort((a, b) => a.localeCompare(b))
  }

  async function getAgent(name: string): Promise<AgentRecord | undefined> {
    const file = await store.read()
    return Object.hasOwn(file.agents, name) ? file.agents[name] : undefined
  }

  async function listAgents(): Promise<readonly AgentRecord[]> {
    const file = await store.read()
    return Object.values(file.agents).sort((a, b) => a.name.localeCompare(b.name))
  }

  async function findAgentByToken(token: string): Promise<AgentRecord | undefined> {
    const file = await store.read()
    // Scan EVERY record (no early return) so a wrong token costs the same
    // work regardless of where — or whether — a matching agent sits.
    let matched: AgentRecord | undefined
    for (const record of Object.values(file.agents)) {
      if (verifyToken(token, record.tokenHash)) matched = record
    }
    if (matched === undefined || matched.revokedAt !== undefined) return undefined
    return matched
  }

  return {
    createAgent,
    revokeAgent,
    grantServer,
    ungrantServer,
    ungrantServerEverywhere,
    getAgent,
    listAgents,
    findAgentByToken,
  }
}
