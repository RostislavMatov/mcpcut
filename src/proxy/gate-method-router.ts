import {
  AGENT_METHOD_LIST_FILTERED_RULE_PREFIX,
  decideMethodGrant,
  filterMethodListResult,
  listItemPredicate,
  type MethodGrantOutcome,
  type MethodListKind,
} from '../agents/method-grants.js'
import type { DecisionInfo } from '../journal/record.js'
import type { Verdict } from './pipeline.js'
import {
  DROP,
  FORWARD,
  GATE_ERROR_RULE,
  argsHashOf,
  bookkeepingDecisionInfo,
  createBoundedIdSet,
  denialBytesFor,
  idKeyOf,
  type DecisionWriter,
  type GateMethodGrants,
} from './gate-helpers.js'

/**
 * The method-grant half of the gate router (M4 Task 6): gating of
 * `resources/*`, `prompts/*` and `completion/complete` frames against the
 * agent's grant dictionary, and grant-filtering of the tracked
 * `resources/list`/`prompts/list` responses. Split out of `gate-router.ts`
 * purely for the <400-line file rule — the router owns dispatch, this module
 * owns the method-grant decision path, both over the same injected
 * journal/answer machinery.
 *
 * Deliberately structural about frames (`MethodFrame` below) and handed the
 * M3 fallback as a CALLBACK: the byte-identical non-grantable denial —
 * including its rule text from `policy/constants.ts` — stays in the router,
 * so this module needs no knowledge of the M3 vocabulary it falls back to.
 */

/** Cap on concurrently-tracked outstanding list request ids, per kind (mirrors tools/list). */
const MAX_TRACKED_METHOD_LIST_IDS = 65_536

/** `rule` journaled when the outstanding grant-managed list id tracker had to evict an id. */
const METHOD_LIST_OVERFLOW_RULE = 'method-list-tracking-overflow'

/**
 * Cap on removed-subject strings journaled for one filtered listing (review
 * M5): resource URIs run up to 2048 chars each, so an unbounded `removed`
 * list would let one hostile listing amplify itself into the journal by
 * orders of magnitude. Past the cap a `+N more` tail carries the count.
 */
const MAX_JOURNALED_REMOVED_SUBJECTS = 20

/** The journal-safe view of a removed-subject list: capped, with a count tail. */
function capRemovedSubjects(removed: readonly string[]): readonly string[] {
  if (removed.length <= MAX_JOURNALED_REMOVED_SUBJECTS) return removed
  const overflow = removed.length - MAX_JOURNALED_REMOVED_SUBJECTS
  return [...removed.slice(0, MAX_JOURNALED_REMOVED_SUBJECTS), `+${overflow} more`]
}

/** The structural subset of a classified request this module needs. */
export interface MethodRequestFrame {
  readonly kind: 'request'
  readonly id: string | number | null
  readonly method: string
  readonly raw: string
}

/** The structural subset of a classified notification this module needs. */
export interface MethodNotificationFrame {
  readonly kind: 'notification'
  readonly method: string
  readonly raw: string
}

/** A discriminated frame, structurally satisfied by `protocol/classify.ts`'s shapes. */
export type MethodFrame = MethodRequestFrame | MethodNotificationFrame

export interface MethodGrantRouterDeps {
  readonly serverName: string
  /** Absent = M3-era scope: every frame takes `denyFallback`. */
  readonly methodGrants?: GateMethodGrants
  readonly writeDecision: DecisionWriter
  /** Resolves once decision records are durable — but only when fail-closed. */
  readonly settleJournal: () => Promise<void>
  /** The gate's local-answer path; a `null` id is dropped (no return address). */
  readonly answerLocally: (
    id: string | number | null,
    build: (id: string | number) => Buffer,
  ) => Promise<void>
  readonly onError: (error: unknown) => void
  /** Produces the EXACT M3 non-grantable denial (rule text and all). */
  readonly denyFallback: (frame: MethodFrame) => Promise<Verdict>
}

export interface MethodGrantRouter {
  /** Gates one client frame whose method belongs to the non-tool surface. */
  gateFrame(frame: MethodFrame): Promise<Verdict>
  /** Claims a tracked list response id; `null` when this id is not ours. */
  takePendingList(idKey: string): MethodListKind | null
  /** Grant-filters one claimed list response (raw JSON line, no framing). */
  filterListResponse(raw: string, list: MethodListKind): Promise<Verdict>
}

export function createMethodGrantRouter(deps: MethodGrantRouterDeps): MethodGrantRouter {
  const { serverName, methodGrants, writeDecision, settleJournal, answerLocally, onError } = deps

  /** Outstanding grant-managed list ids, tracked per kind so the response filter knows its shape. */
  const pendingListIds = {
    resources: trackedIds('resources'),
    prompts: trackedIds('prompts'),
  } as const

  function trackedIds(list: MethodListKind) {
    return createBoundedIdSet(MAX_TRACKED_METHOD_LIST_IDS, (evicted) => {
      writeDecision(
        bookkeepingDecisionInfo(serverName, METHOD_LIST_OVERFLOW_RULE, `${list}/list`, evicted),
      )
    })
  }

  /**
   * `fallback` — no grants object, no matching grant vocabulary, or a method
   * outside the enumerated set — reproduces the M3 denial byte for byte. A
   * granted frame is journaled (allow, class read/write per the plan) and
   * forwarded; a granted LIST request additionally tracks its id. NO policy
   * rules run for these methods — grants decide, the journal records (policy
   * for non-tool methods is M5 backlog).
   */
  async function gateFrame(frame: MethodFrame): Promise<Verdict> {
    const outcome = decideMethodGrant(frame.method, frame.raw, methodGrants)
    if (outcome.action === 'fallback') return deps.denyFallback(frame)
    if (outcome.action === 'deny') return denyFrame(frame, outcome)

    // The ALLOW path is as fail-closed as the deny path (review H1): a journal
    // that cannot settle (ENOSPC, EACCES) must never surface as an unhandled
    // rejection, and must never let the frame through without a durable record.
    try {
      writeDecision(methodDecisionInfo(serverName, frame.method, 'allow', outcome), outcome.params)
      await settleJournal()
    } catch (error: unknown) {
      return failClosedOnJournalError(frame, error)
    }
    if (outcome.list !== undefined && frame.kind === 'request' && frame.id !== null) {
      pendingListIds[outcome.list].add(idKeyOf(frame.id))
    }
    return FORWARD
  }

  /** Journal failure on an allow path: report, answer a local denial, drop. */
  async function failClosedOnJournalError(frame: MethodFrame, error: unknown): Promise<Verdict> {
    onError(error)
    try {
      if (frame.kind === 'request') {
        await answerLocally(frame.id, (sid) =>
          denialBytesFor(sid, { toolName: frame.method, serverName, rule: GATE_ERROR_RULE }),
        )
      }
    } catch (answerError: unknown) {
      onError(answerError)
    }
    return DROP
  }

  /** Same shape as every other local denial: journal, settle, answer (requests only), drop. */
  async function denyFrame(
    frame: MethodFrame,
    outcome: Extract<MethodGrantOutcome, { action: 'deny' }>,
  ): Promise<Verdict> {
    try {
      writeDecision(methodDecisionInfo(serverName, frame.method, 'deny', outcome), outcome.params)
      await settleJournal()
      if (frame.kind === 'request') {
        await answerLocally(frame.id, (sid) =>
          denialBytesFor(sid, { toolName: frame.method, serverName, rule: outcome.rule }),
        )
      }
    } catch (error: unknown) {
      onError(error)
    }
    return DROP
  }

  function takePendingList(idKey: string): MethodListKind | null {
    if (methodGrants === undefined) return null
    if (pendingListIds.resources.delete(idKey)) return 'resources'
    if (pendingListIds.prompts.delete(idKey)) return 'prompts'
    return null
  }

  /**
   * Same posture as the tools/list filter: a shape the filter does not
   * positively recognize forwards unchanged (hygiene, not enforcement —
   * reading a resource is still gated at `resources/read`), and an untouched
   * listing forwards byte-identically.
   */
  async function filterListResponse(raw: string, list: MethodListKind): Promise<Verdict> {
    if (methodGrants === undefined) return FORWARD
    const filtered = filterMethodListResult(raw, list, listItemPredicate(methodGrants, list))
    if (filtered === null || (filtered.removed.length === 0 && filtered.droppedUnreadable === 0)) {
      return FORWARD
    }
    // Fail closed on journal failure (review H1): a rewritten listing must
    // not be emitted without its record; the dropped response is retryable.
    const removedForJournal = capRemovedSubjects(filtered.removed)
    try {
      writeDecision(
        bookkeepingDecisionInfo(
          serverName,
          `${AGENT_METHOD_LIST_FILTERED_RULE_PREFIX}: ${list}/list`,
          `${list}/list`,
          removedForJournal,
        ),
        {
          removed: removedForJournal,
          removedCount: filtered.removed.length,
          droppedUnreadable: filtered.droppedUnreadable,
        },
      )
      await settleJournal()
    } catch (error: unknown) {
      onError(error)
      return DROP
    }
    return { action: 'emit', bytes: Buffer.from(filtered.serialized, 'utf8') }
  }

  return { gateFrame, takePendingList, filterListResponse }
}

/**
 * `DecisionInfo` for a grant-managed non-tool method. Like the non-grantable
 * denial, `toolName` carries the METHOD; unlike it, the class is the plan's
 * journal classification (`read` for read/list/get/complete, `write` for
 * subscribe/unsubscribe) carried on the decided outcome, and the args
 * fingerprint covers the frame's `params` (the URI or prompt name an auditor
 * will ask about).
 */
function methodDecisionInfo(
  serverName: string,
  method: string,
  outcome: 'allow' | 'deny',
  decided: Extract<MethodGrantOutcome, { action: 'deny' | 'forward' }>,
): DecisionInfo {
  return {
    outcome,
    rule: decided.rule,
    serverName,
    toolName: method,
    toolClass: decided.toolClass,
    quarantineState: 'unknown',
    argsHash: argsHashOf(decided.params),
  }
}
