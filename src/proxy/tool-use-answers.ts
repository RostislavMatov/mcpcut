/**
 * The server answers a resend of the same tool use gets (decision M36,
 * phase C). One per PROCESS, shared by every session in it: `serve` sees a
 * 404-driven resend on a NEW session (Claude Code re-initializes, then sends
 * the same call again — smoke 2026-10-09), so a per-session table would miss
 * exactly the case it exists for.
 *
 * Keyed by (agent, tool-use id): the agent's name on an agent session, `''`
 * on `wrap`, which has none; the tool-use id is the client's name for the
 * model's one tool use (`protocol/call-meta.ts`). A call without one is never
 * looked up here (owner, 2026-10-09: a retry and a deliberate second call
 * cannot be told apart without it).
 *
 * Two jobs:
 *  - **Answers.** Every server answer to a call carrying a tool-use id is
 *    kept 24 h, delivered or not — a lost answer looks delivered to the plane.
 *    In memory only (owner, 2026-10-09): nothing written to disk, gone with
 *    the process. Bounded per answer and in all; past the total, delivered
 *    answers leave first, then the oldest.
 *  - **Claims.** While a call of a tool use is held for a human or running at
 *    its server, the same tool use is not decided again: a second call of it
 *    must neither ask twice nor run twice. A claim nobody released (a bug, a
 *    session that never ended) lapses after the longest a call can be held.
 */

/** How long a server answer is kept for a resend (owner, 2026-10-09: "кэш на сутки"). */
export const TOOL_USE_ANSWER_TTL_MS = 24 * 60 * 60 * 1000

/** Largest answer kept, in bytes; a bigger one is journaled as not kept. */
export const MAX_KEPT_ANSWER_BYTES = 1024 * 1024

/** All kept answers of one process together, in bytes. */
export const MAX_KEPT_ANSWERS_BYTES = 64 * 1024 * 1024

/**
 * A claim older than this has outlived any call it could stand for: a held
 * call ends at the 24-hour request cap and a session's teardown grace is
 * seconds — 25 h is the same bound the HTTP front puts on one request's wait.
 */
export const TOOL_USE_CLAIM_MAX_AGE_MS = 25 * 60 * 60 * 1000

/** The call a kept answer belongs to: the same tool-use id under another call is not a resend of it. */
export interface CallIdentity {
  readonly serverName: string
  readonly toolName: string
  readonly argsHash: string
}

export interface AnswerToKeep extends CallIdentity {
  /** The server's response, as received (a JSON-RPC response object). */
  readonly response: string
  /** Whether it went to an agent that was still waiting for it. */
  readonly delivered: boolean
}

export interface KeptAnswer extends AnswerToKeep {
  readonly keptAtMs: number
}

export type KeepOutcome = 'kept' | 'too-large'

/** One call's hold on its tool use; `release()` is idempotent and frees only this claim. */
export interface ToolUseClaim {
  release(): void
}

export interface ToolUseAnswers {
  keep(scope: string, toolUseId: string, answer: AnswerToKeep): KeepOutcome
  /** The answer kept for this tool use, if it belongs to the same call and is younger than 24 h. */
  find(scope: string, toolUseId: string, call: CallIdentity): KeptAnswer | null
  /** `null` while another call of the same tool use holds it. */
  claim(scope: string, toolUseId: string): ToolUseClaim | null
}

export interface ToolUseAnswersOptions {
  readonly clock?: () => number
  readonly maxTotalBytes?: number
}

interface StoredAnswer extends KeptAnswer {
  readonly bytes: number
}

interface ClaimEntry {
  readonly claimedAtMs: number
}

function keyOf(scope: string, toolUseId: string): string {
  // NUL cannot occur in a tool-use id (`call-meta.ts` refuses control
  // characters), so no two (scope, id) pairs share a key.
  return `${scope}\u0000${toolUseId}`
}

function isSameCall(answer: CallIdentity, call: CallIdentity): boolean {
  return (
    answer.serverName === call.serverName && answer.toolName === call.toolName && answer.argsHash === call.argsHash
  )
}

export function createToolUseAnswers(options: ToolUseAnswersOptions = {}): ToolUseAnswers {
  const clock = options.clock ?? Date.now
  const maxTotalBytes = options.maxTotalBytes ?? MAX_KEPT_ANSWERS_BYTES
  /** Insertion-ordered, oldest first: a re-kept answer is deleted and set again. */
  const answers = new Map<string, StoredAnswer>()
  const claims = new Map<string, ClaimEntry>()
  let totalBytes = 0

  function forget(key: string): void {
    const stored = answers.get(key)
    if (stored === undefined) return
    answers.delete(key)
    totalBytes -= stored.bytes
  }

  function isExpired(stored: StoredAnswer, now: number): boolean {
    return now - stored.keptAtMs >= TOOL_USE_ANSWER_TTL_MS
  }

  /** Expired first, then delivered oldest-first, then anything oldest-first, until `incoming` fits. */
  function makeRoom(incoming: number, now: number): void {
    for (const [key, stored] of [...answers]) {
      if (isExpired(stored, now)) forget(key)
    }
    const fits = (): boolean => totalBytes + incoming <= maxTotalBytes
    for (const [key, stored] of [...answers]) {
      if (fits()) return
      if (stored.delivered) forget(key)
    }
    for (const key of [...answers.keys()]) {
      if (fits()) return
      forget(key)
    }
  }

  return {
    keep(scope, toolUseId, answer) {
      const bytes = Buffer.byteLength(answer.response, 'utf8')
      if (bytes > MAX_KEPT_ANSWER_BYTES || bytes > maxTotalBytes) return 'too-large'
      const key = keyOf(scope, toolUseId)
      const now = clock()
      forget(key)
      makeRoom(bytes, now)
      answers.set(key, Object.freeze({ ...answer, keptAtMs: now, bytes }))
      totalBytes += bytes
      return 'kept'
    },

    find(scope, toolUseId, call) {
      const key = keyOf(scope, toolUseId)
      const stored = answers.get(key)
      if (stored === undefined) return null
      if (isExpired(stored, clock())) {
        forget(key)
        return null
      }
      if (!isSameCall(stored, call)) return null
      const { bytes: _bytes, ...kept } = stored
      return kept
    },

    claim(scope, toolUseId) {
      const key = keyOf(scope, toolUseId)
      const now = clock()
      const held = claims.get(key)
      if (held !== undefined && now - held.claimedAtMs < TOOL_USE_CLAIM_MAX_AGE_MS) return null
      const entry: ClaimEntry = Object.freeze({ claimedAtMs: now })
      claims.set(key, entry)
      return {
        release() {
          if (claims.get(key) === entry) claims.delete(key)
        },
      }
    },
  }
}
