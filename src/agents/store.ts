import { join } from 'node:path'
import { z } from 'zod'
import { JOURNAL_DIR } from '../config.js'
import { compareAsText } from './effective.js'
import { createJsonStore, type JsonStore } from '../policy/store.js'
import { AGENTS_FILE_NAME } from './constants.js'
import {
  assertValidAgentName,
  assertValidServerName,
  buildGrant,
  type MethodGrantsInput,
} from './grant-input.js'
import { parseAgentsFile, type AgentGrant, type AgentRecord, type AgentsFile } from './schema.js'
import { generateToken, verifyToken } from './tokens.js'

/**
 * The grant-input vocabulary is re-exported so every existing import site
 * (`from '../agents/store.js'`) keeps working: the assertions and their error
 * classes moved to `grant-input.ts` when the group store started sharing
 * them, and neither store imports the other.
 */
export {
  InvalidAgentNameError,
  InvalidPromptPatternError,
  InvalidResourcePatternError,
  InvalidServerNameError,
  InvalidToolPatternError,
  type MethodGrantsInput,
} from './grant-input.js'

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
    const grant: AgentGrant = buildGrant(tools, methods)

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
    // Code-unit order, like every array that ends up in an `access-edit`
    // record: locale collation varies with the runtime's ICU data.
    return [...affected].sort(compareAsText)
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
