import { AGENT_NAME_PATTERN, GRANT_SERVER_NAME_PATTERN } from '../agents/constants.js'
import { MAX_RESOURCE_PATTERN_CHARS, RESOURCE_GRANT_PATTERN } from '../agents/method-grants.js'
import type { AgentGrant } from '../agents/schema.js'
import {
  InvalidAgentNameError,
  InvalidPromptPatternError,
  InvalidResourcePatternError,
  InvalidServerNameError,
  InvalidToolPatternError,
  type MethodGrantsInput,
} from '../agents/store.js'
import { RESERVED_OBJECT_KEYS, TOOL_RULE_NAME_PATTERN } from '../policy/constants.js'

/**
 * Input validation for a GROUP grant, deliberately identical to the private
 * assertions of `agents/store.ts` (`assertValid*`, and the grant assembly in
 * `grantServer`) and raising the very same error classes: a group grant IS an
 * agent grant (decision G1), so "what a caller may hand the store" must not
 * drift between the two stores — one shape, one message, one allowlist for
 * CLI/UI error handling.
 *
 * It lives here rather than being hoisted out of `agents/store.ts` because
 * that file is outside this task's ownership; the same precedent as
 * `withMaxEntries` mirroring `policy/schema.ts` and `classify-tool.ts`
 * mirroring `match.ts`. Hoisting both call sites onto this module is a safe
 * later cleanup.
 */

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
