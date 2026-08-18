import type { QuarantineState } from '../journal/record.js'
import { matchToolRule } from './match.js'
import type { SurfaceDelta } from './schema-diff.js'
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
  /**
   * True once the inventory has processed at least one `tools/list` for this
   * server. Gates the `shadow-tool` rule: a `'unknown'` tool seen AFTER the
   * catalog is known is a tool the server never advertised (a shadow tool).
   */
  readonly catalogObserved: boolean
  /**
   * False when the inventory could not be trusted for this decision (a corrupt
   * / unavailable store, a failed `tools/list` persist, or a too-large catalog
   * that blew the quarantine cap). Forces a fail-closed outcome regardless of
   * quarantine state -- enforcement data we cannot trust must never allow.
   */
  readonly catalogTrusted: boolean
  /**
   * The agent dimension (M3). Absent on the ad-hoc `wrap` path (no agent
   * identity) -- exactly the M2 behavior. `'granted'` means the caller has
   * already resolved the agent's grant matrix (`agentScope`) and it covers
   * this tool: the M2 chain runs unchanged. `'not-granted'` denies
   * immediately, before every other step -- what was never granted to an
   * agent cannot be allowed by approvals, rules, or defaults.
   */
  readonly agentGrant?: AgentGrantStatus
  /**
   * Direction of the tool's advertised-input surface versus the descriptor the
   * operator approved, for a tool whose `quarantineState` is `'changed'`
   * (M5 wave 6, owner decision O4). ABSENT means the direction could not be
   * established -- the approval predates descriptor storage, or a stored
   * schema was truncated -- and is treated as "not provably narrower", never
   * as "no change": absence of the signal is not evidence of safety.
   *
   * Read by `decideByToolRule` alone, and only to withdraw an explicit
   * `allow`. It never raises a tool's class and never *relaxes* an outcome.
   */
  readonly surfaceDelta?: SurfaceDelta
}

/** Resolved agent-grant status for one call; see `DecideInput.agentGrant`. */
export type AgentGrantStatus = 'granted' | 'not-granted'

/**
 * The resolved outcome of one policy evaluation, plus enough context for an
 * auditor reading the journal to see exactly which rule fired. `rule` is
 * always derived from policy config (a fixed literal, or a `servers.<name>`
 * / pattern path) -- never the tool name -- so the same rule string is
 * stable across every tool it happens to match. The one deliberate
 * exception is the agent-grant deny (`agent: no grant for <server>/<tool>`):
 * there is no config path to point at (the *absence* of a grant fired), so
 * the rule names the exact server/tool pair the auditor needs.
 */
export interface PolicyDecision {
  readonly outcome: PolicyOutcome
  readonly rule: string
  readonly reason: string
}

const QUARANTINED_STATES: ReadonlySet<QuarantineState> = new Set(['new', 'changed'])

/**
 * `rule` recorded when an explicit per-tool `allow` was withdrawn because the
 * tool's surface changed after the operator approved it (O4). A rule of its
 * own rather than the superseded config path: an auditor filtering the journal
 * for "outcomes that did not follow the written policy" needs one stable
 * string to filter on, and the superseded path is named in `reason`.
 */
export const SURFACE_CHANGED_RULE = 'surface-changed'

/**
 * The deltas under which an operator's explicit `allow` still covers the tool:
 * the accepted-input surface got SMALLER (`narrowed`), or the change was
 * wording only (`neutral`, e.g. a description edit). Everything else --
 * `widened`, the ambiguous `changed`, and an absent (uncomputable) delta --
 * means the rule was written against a surface that no longer exists.
 */
const ALLOW_SURVIVING_DELTAS: ReadonlySet<SurfaceDelta> = new Set<SurfaceDelta>(['narrowed', 'neutral'])

/**
 * Resolves the outcome a quarantine-like rule (`quarantine`, `shadow-tool`,
 * `catalog-untrusted`) fires with. `onQuarantined` is schema-constrained to
 * `deny | require-approval`, but this defends in depth: a missing value falls
 * back to `require-approval`, and an `allow` (impossible today, but a future
 * schema change must not silently open the gate) is forced to
 * `require-approval`. Untrusted/quarantined enforcement never allows.
 */
function failClosedQuarantineOutcome(policy: Policy): PolicyOutcome {
  // Widened to `PolicyOutcome` on purpose: `onQuarantined` is schema-limited to
  // `deny | require-approval` today, but this guard must survive a future
  // schema change that could add `allow` -- an untrusted/quarantined tool must
  // never resolve to `allow`.
  const configured = (policy.quarantine.onQuarantined ?? 'require-approval') as PolicyOutcome
  return configured === 'allow' ? 'require-approval' : configured
}

/**
 * Resolves the policy outcome for one tool call. Pure function: no I/O, no
 * `Date.now`, no hidden state -- every input it needs is on `DecideInput`.
 *
 * Precedence (strict, first match wins):
 *  0. `agentGrant === 'not-granted'` -- the agent's grant matrix does not
 *     cover this tool; always deny, before approvals grants and every rule.
 *     A grant defines what an agent may touch at all -- policy only decides
 *     what happens to what was granted. Absent field (ad-hoc `wrap`) or
 *     `'granted'` fall through to the chain below unchanged.
 *  1. `hasActiveGrant` -- an operator already approved this exact call
 *     shape; always allow.
 *  2. An explicit tool rule under `servers.<serverName>.tools` (exact name,
 *     then longest trailing-glob prefix) -- an operator's deliberate,
 *     per-tool decision, so it outranks quarantine and every default. The
 *     one exception is O4's withdrawal (`withdrawnBySurfaceChange`): an
 *     `allow` written against a surface the server has since widened stops
 *     covering the call and falls to the configured drift posture.
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
    decideByAgentGrant(input) ??
    decideByGrant(input) ??
    decideByToolRule(input) ??
    decideByCatalogUntrusted(input) ??
    decideByQuarantine(input) ??
    decideByServerDefault(input) ??
    decideByClassDefault(input) ??
    decideByGlobalDefault(input)
  )
}

/**
 * Fail-closed guard: when the inventory could not be trusted for this call
 * (corrupt/unavailable store, failed persist, catalog too large to enforce),
 * we cannot rely on `quarantineState`, so we short-circuit to a safe outcome
 * BEFORE the defaults could allow the call. Applies regardless of
 * `quarantine.enabled`: an operator disabling quarantine opts out of gating
 * *known* schema drift, not out of "we lost the enforcement data entirely".
 */
function decideByCatalogUntrusted(input: DecideInput): PolicyDecision | null {
  if (input.catalogTrusted) return null
  return {
    outcome: failClosedQuarantineOutcome(input.policy),
    rule: 'catalog-untrusted',
    reason: 'tool inventory is untrusted (corrupt/unavailable store or oversized catalog); failing closed',
  }
}

/**
 * Step 0, the agent dimension: a tool the agent's grant matrix does not
 * cover is denied before anything else can run -- an approvals grant or an
 * allow rule must never resurrect what an operator never handed out.
 * Missing `agentGrant` (ad-hoc `wrap`, no agent identity) and `'granted'`
 * both fall through, leaving the M2 chain byte-for-byte unchanged.
 */
function decideByAgentGrant(input: DecideInput): PolicyDecision | null {
  if (input.agentGrant !== 'not-granted') return null
  return {
    outcome: 'deny',
    rule: `agent: no grant for ${input.serverName}/${input.toolName}`,
    reason: `the agent has no grant covering tool '${input.toolName}' on server '${input.serverName}'; denied before policy evaluation`,
  }
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
  const path = `servers.${input.serverName}.tools.${match.pattern}`
  return (
    withdrawnBySurfaceChange(input, match.value, path) ?? {
      outcome: match.value,
      rule: path,
      reason: `explicit tool rule '${match.pattern}' on server '${input.serverName}' resolved to '${match.value}'`,
    }
  )
}

/**
 * Owner decision O4 (M5 wave 6): an explicit `allow` is a statement about a
 * surface the operator LOOKED AT. Once the server advertises a wider (or
 * unrecognizably different) surface for that tool, the statement no longer
 * covers the calls now possible, so the rule stops applying and the call
 * lands on the operator's configured drift posture instead.
 *
 * Only `allow` is withdrawn: `deny` and `require-approval` are already at
 * least as strict as anything this could escalate to, and rewriting their
 * rule string would only cost the auditor the config path.
 *
 * Gated on `quarantine.enabled`, deliberately: that flag IS the operator's
 * switch for gating known schema drift, and honoring an explicit `allow` while
 * ignoring the switch that turns drift gating off would be two answers to one
 * question. `state: 'new'` is untouched for the mirror-image reason -- a rule
 * written for a tool that was never approved was never written against an
 * approved surface, and step 2 has always outranked quarantine there.
 *
 * The outcome comes from `onQuarantined` rather than a hardcoded
 * `require-approval`: an operator who set drift to `deny` gets a deny, and
 * `failClosedQuarantineOutcome` guarantees this can never resolve to `allow`
 * -- withdrawing a rule must not be a path that re-allows the call.
 */
function withdrawnBySurfaceChange(
  input: DecideInput,
  ruleOutcome: PolicyOutcome,
  path: string,
): PolicyDecision | null {
  if (ruleOutcome !== 'allow') return null
  if (!input.policy.quarantine.enabled) return null
  if (input.quarantineState !== 'changed') return null
  if (input.surfaceDelta !== undefined && ALLOW_SURVIVING_DELTAS.has(input.surfaceDelta)) return null

  const surface =
    input.surfaceDelta === undefined
      ? 'the direction of the change could not be determined'
      : `the accepted-input surface is '${input.surfaceDelta}'`
  return {
    outcome: failClosedQuarantineOutcome(input.policy),
    rule: SURFACE_CHANGED_RULE,
    reason:
      `tool '${input.toolName}' on server '${input.serverName}' changed after it was approved, and ` +
      `${surface}; the explicit rule '${path}' was written against the earlier surface and no longer covers this call`,
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

  const isQuarantined = QUARANTINED_STATES.has(input.quarantineState)
  // Shadow tool: a call for a name the inventory never saw in `tools/list`,
  // AFTER the catalog is known. Before the first observe (`catalogObserved ===
  // false`) `unknown` still falls through to the defaults, tolerating the
  // realistic startup ordering where a call precedes the first `tools/list`.
  const isShadow = input.quarantineState === 'unknown' && input.catalogObserved
  if (!isQuarantined && !isShadow) return null

  return {
    outcome: failClosedQuarantineOutcome(input.policy),
    rule: isShadow ? 'shadow-tool' : 'quarantine',
    reason: isShadow
      ? `tool '${input.toolName}' was never advertised in tools/list (shadow tool)`
      : `tool schema quarantine state is '${input.quarantineState}'`,
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
