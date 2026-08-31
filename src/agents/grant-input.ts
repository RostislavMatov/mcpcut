import { RESERVED_OBJECT_KEYS, TOOL_RULE_NAME_PATTERN } from '../policy/constants.js'
import { AGENT_NAME_PATTERN, GRANT_SERVER_NAME_PATTERN } from './constants.js'
import { MAX_RESOURCE_PATTERN_CHARS, RESOURCE_GRANT_PATTERN } from './method-grants.js'
import type { AgentGrant } from './schema.js'

/**
 * Input validation for ONE grant, and the vocabulary of refusals that goes
 * with it. A group grant IS an agent grant (decision G1), so "what a caller
 * may hand the store" must not drift between `agents/store.ts` and
 * `groups/store.ts` — one shape, one message, one allowlist for CLI/UI error
 * handling. Both stores call in here.
 *
 * The error classes live HERE rather than in `agents/store.ts` so that this
 * module depends on neither store and neither store has to import the other:
 * `agents/store.ts` re-exports them, which is why every existing import site
 * (`from '../agents/store.js'`) keeps working unchanged.
 */

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

/** The optional resources/prompts dimension of one grant (M4 Task 6). */
export interface MethodGrantsInput {
  readonly resources?: '*' | readonly string[]
  readonly prompts?: '*' | readonly string[]
}

/** Rejects a grant target that is not a registry-shaped server name. */
export function assertValidServerName(server: string): void {
  if (!GRANT_SERVER_NAME_PATTERN.test(server) || RESERVED_OBJECT_KEYS.includes(server)) {
    throw new InvalidServerNameError(server)
  }
}

/** Rejects an agent name (member) outside `^[a-z0-9][a-z0-9-]{0,63}$`. */
export function assertValidAgentName(name: string): void {
  if (!AGENT_NAME_PATTERN.test(name) || RESERVED_OBJECT_KEYS.includes(name)) {
    throw new InvalidAgentNameError(name)
  }
}

function assertValidToolPatterns(tools: readonly string[]): void {
  for (const pattern of tools) {
    if (!TOOL_RULE_NAME_PATTERN.test(pattern) || RESERVED_OBJECT_KEYS.includes(pattern)) {
      throw new InvalidToolPatternError(pattern)
    }
  }
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

/**
 * Validates the caller's grant input and returns the value to store. Every
 * array is COPIED (the caller must not be able to mutate stored state through
 * the reference it passed), and an omitted `resources`/`prompts` field stays
 * absent — that absence is what keeps the M3 fail-closed denial of the
 * corresponding methods.
 */
export function buildGrant(
  tools: readonly string[] | '*',
  methods: MethodGrantsInput = {},
): AgentGrant {
  if (tools !== '*') assertValidToolPatterns(tools)
  if (methods.resources !== undefined && methods.resources !== '*') {
    assertValidResourcePatterns(methods.resources)
  }
  if (methods.prompts !== undefined && methods.prompts !== '*') {
    assertValidPromptPatterns(methods.prompts)
  }

  return {
    tools: tools === '*' ? '*' : [...tools],
    ...(methods.resources !== undefined
      ? { resources: methods.resources === '*' ? ('*' as const) : [...methods.resources] }
      : {}),
    ...(methods.prompts !== undefined
      ? { prompts: methods.prompts === '*' ? ('*' as const) : [...methods.prompts] }
      : {}),
  }
}
