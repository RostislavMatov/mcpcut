import type { QuarantineState } from '../journal/record.js'
import { matchToolRule } from './match.js'
import type { Policy, PolicyOutcome, ToolClass } from './schema.js'

/**
 * Everything `decide()` needs to resolve one tool call to a policy outcome.
 * Deliberately flat data, no I/O: the caller (inventory + grant store) has
 * already resolved the tool's class, quarantine state, and grant status
 * before calling in, so this function stays pure and trivially testable.
 */
export interface DecideInput {
  readonly policy: Policy
  readonly serverName: string
  readonly toolName: string
  readonly toolClass: ToolClass
  readonly quarantineState: QuarantineState
  readonly hasActiveGrant: boolean
}

/**
 * The resolved outcome of one policy evaluation, plus enough context for an
 * auditor reading the journal to see exactly which rule fired. `rule` is
 * always derived from policy config (a fixed literal, or a `servers.<name>`
 * / pattern path) -- never the tool name -- so the same rule string is
 * stable across every tool it happens to match.
 */
export interface PolicyDecision {
  readonly outcome: PolicyOutcome
  readonly rule: string
  readonly reason: string
}

const QUARANTINED_STATES: ReadonlySet<QuarantineState> = new Set(['new', 'changed'])

/**
 * Resolves the policy outcome for one tool call. Pure function: no I/O, no
 * `Date.now`, no hidden state -- every input it needs is on `DecideInput`.
 *
 * Precedence (strict, first match wins):
 *  1. `hasActiveGrant` -- an operator already approved this exact call
 *     shape; always allow.
 *  2. An explicit tool rule under `servers.<serverName>.tools` (exact name,
 *     then longest trailing-glob prefix) -- an operator's deliberate,
 *     per-tool decision, so it outranks quarantine and every default.
 *  3. Quarantine -- if enabled and the tool's schema is `new` or `changed`,
 *     resolves to `policy.quarantine.onQuarantined`. Sits above the
 *     defaults (a default must never silently bypass quarantine) but below
 *     an explicit tool rule (see step 2).
 *  4. `servers.<serverName>.defaultDecision`.
 *  5. `classDefaults[toolClass]`.
 *  6. `policy.defaultDecision` -- the final fallback, always defined.
 */
export function decide(input: DecideInput): PolicyDecision {
  return (
    decideByGrant(input) ??
    decideByToolRule(input) ??
    decideByQuarantine(input) ??
    decideByServerDefault(input) ??
    decideByClassDefault(input) ??
    decideByGlobalDefault(input)
  )
}

function decideByGrant(input: DecideInput): PolicyDecision | null {
  if (!input.hasActiveGrant) return null
  return {
    outcome: 'allow',
    rule: 'grant',
    reason: 'an active grant already permits this call; skipping further policy evaluation',
  }
}

function decideByToolRule(input: DecideInput): PolicyDecision | null {
  const serverRules = input.policy.servers?.[input.serverName]?.tools
  const match = matchToolRule(serverRules, input.toolName)
  if (!match) return null
  return {
    outcome: match.value,
    rule: `servers.${input.serverName}.tools.${match.pattern}`,
    reason: `explicit tool rule '${match.pattern}' on server '${input.serverName}' resolved to '${match.value}'`,
  }
}

/**
 * Quarantine state `'unknown'` (the tool has never appeared in a
 * `tools/list` response the inventory has observed) intentionally does NOT
 * trigger this branch. Treating `unknown` as quarantined would deny or gate
 * every call made before the inventory has had a chance to observe
 * `tools/list` -- a realistic ordering during proxy startup, not an attack --
 * which would break otherwise-legitimate early traffic. Falling through to
 * the defaults instead still lands on a safe outcome: an unclassified tool
 * defaults to the `write` class (see `classify-tool.ts`), and operators can
 * set `classDefaults.write` to `require-approval` or `deny` if they want
 * unknown tools gated too.
 */
function decideByQuarantine(input: DecideInput): PolicyDecision | null {
  const { quarantine } = input.policy
  if (!quarantine.enabled) return null
  if (!QUARANTINED_STATES.has(input.quarantineState)) return null
  return {
    outcome: quarantine.onQuarantined,
    rule: 'quarantine',
    reason: `tool schema quarantine state is '${input.quarantineState}'`,
  }
}

function decideByServerDefault(input: DecideInput): PolicyDecision | null {
  const serverDefault = input.policy.servers?.[input.serverName]?.defaultDecision
  if (serverDefault === undefined) return null
  return {
    outcome: serverDefault,
    rule: `servers.${input.serverName}.defaultDecision`,
    reason: `server '${input.serverName}' default decision is '${serverDefault}'`,
  }
}

function decideByClassDefault(input: DecideInput): PolicyDecision | null {
  const classDefault = input.policy.classDefaults?.[input.toolClass]
  if (classDefault === undefined) return null
  return {
    outcome: classDefault,
    rule: `classDefaults.${input.toolClass}`,
    reason: `class default for '${input.toolClass}' is '${classDefault}'`,
  }
}

function decideByGlobalDefault(input: DecideInput): PolicyDecision {
  return {
    outcome: input.policy.defaultDecision,
    rule: 'defaultDecision',
    reason: `policy default decision is '${input.policy.defaultDecision}'`,
  }
}
