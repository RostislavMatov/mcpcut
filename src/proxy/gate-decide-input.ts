import { classifyTool } from '../policy/classify-tool.js'
import type { DecideInput, PolicyDecision } from '../policy/decide.js'
import type { PolicyProvider } from '../policy/reload.js'
import type { ToolClass } from '../policy/schema.js'
import type { ParsedToolCall, ToolDescriptor } from '../protocol/mcp.js'
import {
  CATALOG_UNTRUSTED_RULE,
  argsHashOf,
  type CallFacts,
  type GateAgentScope,
  type GateInventory,
} from './gate-helpers.js'

/**
 * Assembly of the inputs one `tools/call` is decided from, split out of
 * `gate-core.ts`.
 *
 * The seam is deliberate: everything here is a pure function of the policy,
 * the inventory and the agent scope — the session's *rules*, not its *state*.
 * None of it touches the answered-id LRU, the outstanding-verdict set, the
 * enqueued-approval set or the client sink, which is why it can leave the
 * gate core without dragging session lifetime with it. The one piece of
 * mutable session state it needs, the gate's own record of an inventory
 * `load()` rejection, arrives as a getter rather than a captured `let`, so
 * ownership of that flag stays with the gate.
 */

/** Everything the assembler reads. All of it is rules, none of it is session state. */
export interface DecideInputAssemblerDeps {
  /** Read per call (`current()`), never captured: the rules may be hot-reloaded under the session. */
  readonly policy: PolicyProvider
  readonly serverName: string
  readonly inventory: GateInventory
  /** Present only on an agent session; absent means the M2 chain runs unchanged. */
  readonly agentScope?: GateAgentScope
  /** This server's class overrides from the policy IN FORCE — a getter, for the same reason. */
  readonly classOverridesOf: () => Record<string, ToolClass> | undefined
  /** The tool catalog's descriptor lookup (`tool-catalog.ts`). */
  readonly descriptorOf: (toolName: string) => ToolDescriptor
  /**
   * The gate's own record of an inventory `load()` rejection. A getter, not a
   * boolean: it flips after this assembler is built, and reading a stale copy
   * would let a call decided on a failed inventory escape the fail-closed
   * branch below.
   */
  readonly hasInventoryLoadFailed: () => boolean
}

export function createDecideInputAssembler(deps: DecideInputAssemblerDeps) {
  const { policy, serverName, inventory, agentScope } = deps

  /** Resolves class, quarantine state and args fingerprint for one call. Fails closed by throwing. */
  function factsOf(call: ParsedToolCall): CallFacts {
    return {
      serverName,
      toolName: call.toolName,
      toolClass: classifyTool(deps.descriptorOf(call.toolName), deps.classOverridesOf()),
      quarantineState: inventory.stateOf(call.toolName),
      argsHash: argsHashOf(call.args),
    }
  }

  /**
   * The optional agent dimension is spread in rather than assigned, so
   * `exactOptionalPropertyTypes` never sees an explicit `undefined`: with an
   * `agentScope`, `decide()` sees `'granted' | 'not-granted'` (step 0 of its
   * chain); without one, the key is absent and the M2 chain runs unchanged.
   */
  function decideInputOf(facts: CallFacts, hasActiveGrant: boolean): DecideInput {
    // Read here rather than carried on `CallFacts`: the delta is an input to
    // the decision, not a fact recorded about the call, and `factsOf` feeds
    // the journal record. Only a `changed` tool can have one, and asking the
    // inventory for anything else is answered with `undefined` anyway -- so
    // the read is unconditional, and the meaning of an absent value stays one
    // thing everywhere (`decide()`: "no direction established").
    const surfaceDelta = inventory.surfaceDeltaOf(facts.toolName)
    return {
      policy: policy.current(),
      serverName,
      toolName: facts.toolName,
      toolClass: facts.toolClass,
      quarantineState: facts.quarantineState,
      hasActiveGrant,
      catalogObserved: inventory.hasObservedCatalog(),
      catalogTrusted: inventory.isCatalogTrusted(),
      ...(surfaceDelta !== undefined ? { surfaceDelta } : {}),
      ...(agentScope !== undefined
        ? { agentGrant: agentScope.isGranted(facts.toolName) ? ('granted' as const) : ('not-granted' as const) }
        : {}),
    }
  }

  /**
   * Defense-in-depth fail-closed for an untrusted catalog (C3/C4). The pinned
   * `decide()` already forces this from the `catalogTrusted` input; enforcing
   * it here too means a failed/compromised inventory can never let a call
   * through even if the policy layer regresses. A no-op once the decision is
   * already non-allow for the untrusted state.
   */
  function enforceCatalogTrust(decision: PolicyDecision): PolicyDecision {
    if (decision.outcome !== 'allow') return decision
    if (inventory.isCatalogTrusted() && !deps.hasInventoryLoadFailed()) return decision
    return {
      outcome: 'deny',
      rule: CATALOG_UNTRUSTED_RULE,
      reason: 'tool catalog is untrusted (inventory observe/load failed); failing closed',
    }
  }

  return { factsOf, decideInputOf, enforceCatalogTrust }
}
