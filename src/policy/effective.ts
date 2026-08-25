import type { QuarantineState } from '../journal/decision-info.js'
import type { ToolDescriptor } from '../protocol/mcp.js'
import { classifyTool } from './classify-tool.js'
import { SURFACE_CHANGED_RULE, decide, type DecideInput, type PolicyDecision } from './decide.js'
import type { SurfaceDelta } from './schema-diff.js'
import type { Policy, PolicyOutcome, ToolClass } from './schema.js'

/**
 * The "effective outcome" projection the `/servers` card renders for one
 * tool: what a plain call would resolve to right now, and which rule says
 * so. A thin wrapper over `decide()` -- it assembles the same `DecideInput`
 * the gate builds for a call that carries no grant, no agent identity and a
 * trusted, observed catalog, then names the source of the returned `rule`.
 * It never reads the policy on its own: there is exactly one interpretation
 * of the policy in this codebase, and it lives in `decide()`.
 */

/** Where the effective outcome came from, in `decide()`'s precedence order. */
export type EffectiveRuleSource =
  | 'explicit'
  | 'wildcard'
  | 'surface-changed'
  | 'quarantine'
  | 'shadow-tool'
  | 'server-default'
  | 'class-default'
  | 'global-default'

export interface EffectiveToolRule {
  readonly outcome: PolicyOutcome
  readonly source: EffectiveRuleSource
  /** `PolicyDecision.rule` verbatim -- the config path or fixed literal an auditor sees in the journal. */
  readonly rulePath: string
  /** The `servers.<name>.tools` key that matched; present for `explicit` and `wildcard` only. */
  readonly pattern?: string
  /** The class the tool was decided under (`classifyTool`, honoring the server's `classOverrides`). */
  readonly toolClass: ToolClass
}

export interface EffectiveToolInput {
  readonly policy: Policy
  readonly serverName: string
  readonly tool: {
    readonly name: string
    /** Absent when the inventory has no descriptor; classified from the bare name, like the catalog fallback. */
    readonly descriptor?: ToolDescriptor
    readonly quarantineState: QuarantineState
    readonly surfaceDelta?: SurfaceDelta
  }
}

/** Test seam only: lets a suite feed a rule string `decide()` does not produce today. */
export interface EffectiveToolRuleOptions {
  readonly decideFn?: (input: DecideInput) => PolicyDecision
}

/**
 * Thrown when `decide()` returned a `rule` this mapping does not recognize.
 * Loud on purpose: a rule added to `decide()` must surface here (and in the
 * exhaustiveness test) rather than be rendered under a wrong label.
 */
export class UnmappedPolicyRuleError extends Error {
  constructor(readonly rule: string) {
    super(`effectiveToolRule: decide() returned an unmapped rule '${rule}'`)
    this.name = 'UnmappedPolicyRuleError'
  }
}

/** Resolves the outcome and its source for a plain view of `tool` on `serverName`. */
export function effectiveToolRule(
  input: EffectiveToolInput,
  options: EffectiveToolRuleOptions = {},
): EffectiveToolRule {
  const decideInput = plainViewDecideInput(input)
  const decision = (options.decideFn ?? decide)(decideInput)
  const { source, pattern } = sourceOfRule(decision.rule, decideInput)
  return {
    outcome: decision.outcome,
    source,
    rulePath: decision.rule,
    ...(pattern !== undefined ? { pattern } : {}),
    toolClass: decideInput.toolClass,
  }
}

/** True when `servers.<serverName>.tools` holds `toolName` as an exact key (what the UI's "reset" removes). */
export function hasExplicitRule(policy: Policy, serverName: string, toolName: string): boolean {
  const rules = policy.servers?.[serverName]?.tools
  return rules !== undefined && Object.hasOwn(rules, toolName)
}

/**
 * Mirrors `gate-decide-input.ts` for a call with nothing session-specific:
 * `classOverrides` narrowed from the same server entry the gate reads
 * (`gate-core.ts`), the descriptor falling back to `{ name }` exactly as the
 * tool catalog does, and the catalog treated as observed and trusted -- the
 * card is looking at the inventory, so the inventory has been observed.
 */
function plainViewDecideInput(input: EffectiveToolInput): DecideInput {
  const { policy, serverName, tool } = input
  const classOverrides = policy.servers?.[serverName]?.classOverrides
  const descriptor = tool.descriptor ?? { name: tool.name }
  return {
    policy,
    serverName,
    toolName: tool.name,
    toolClass: classifyTool(descriptor, classOverrides),
    quarantineState: tool.quarantineState,
    hasActiveGrant: false,
    catalogObserved: true,
    catalogTrusted: true,
    ...(tool.surfaceDelta !== undefined ? { surfaceDelta: tool.surfaceDelta } : {}),
  }
}

interface ResolvedSource {
  readonly source: EffectiveRuleSource
  readonly pattern?: string
}

const FIXED_RULE_SOURCES: Readonly<Record<string, EffectiveRuleSource>> = {
  [SURFACE_CHANGED_RULE]: 'surface-changed',
  quarantine: 'quarantine',
  'shadow-tool': 'shadow-tool',
  defaultDecision: 'global-default',
}

/**
 * Maps `PolicyDecision.rule` to a source. Path-shaped rules are matched by
 * the exact prefix `decide()` builds from THIS input's server name, so a
 * server name containing dots cannot be mis-split. `grant`, `agent: ...` and
 * `catalog-untrusted` are unreachable for the input built above and are
 * deliberately not mapped: reaching this function with one of them means the
 * input assembly changed, which must fail loudly.
 */
function sourceOfRule(rule: string, input: DecideInput): ResolvedSource {
  const fixed = Object.hasOwn(FIXED_RULE_SOURCES, rule) ? FIXED_RULE_SOURCES[rule] : undefined
  if (fixed !== undefined) return { source: fixed }

  if (rule === `servers.${input.serverName}.defaultDecision`) return { source: 'server-default' }
  if (rule === `classDefaults.${input.toolClass}`) return { source: 'class-default' }

  const toolRulePrefix = `servers.${input.serverName}.tools.`
  if (rule.startsWith(toolRulePrefix)) {
    return toolRuleSource(rule.slice(toolRulePrefix.length), input.toolName)
  }

  throw new UnmappedPolicyRuleError(rule)
}

/** `explicit` when the key IS the tool name; `wildcard` for a trailing-glob key. Anything else cannot come from `matchToolRule`. */
function toolRuleSource(pattern: string, toolName: string): ResolvedSource {
  if (pattern === toolName) return { source: 'explicit', pattern }
  if (pattern.endsWith('*')) return { source: 'wildcard', pattern }
  throw new UnmappedPolicyRuleError(`servers.*.tools.${pattern}`)
}
