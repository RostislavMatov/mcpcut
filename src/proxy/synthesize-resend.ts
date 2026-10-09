import { synthesizeError, type SynthesizableId } from './synthesize.js'

/**
 * The local answer to a resend of a tool use (decision M36, phase C) the
 * plane cannot give the first result: the server answered, but too much to
 * keep. Split from `synthesize.ts` by topic. Agent-facing UX like every
 * synthesized answer: what happened, and what calling again does.
 */

/** A resend the plane answered itself rather than run the call a second time. */
export const ERROR_CODE_RESEND = -32004

export interface AnswerNotKeptErrorInfo {
  readonly toolName: string
  /** When the server answered the first call, ISO 8601. */
  readonly answeredAt: string
  readonly bytes: number
}

/** The tool use already ran, but its answer was too large to keep for a resend. */
export function answerNotKeptError(id: SynthesizableId, info: AnswerNotKeptErrorInfo): Buffer {
  return synthesizeError(id, {
    code: ERROR_CODE_RESEND,
    message:
      `This call of tool "${info.toolName}" repeats one the server already answered at ` +
      `${info.answeredAt}; that answer (${info.bytes} bytes) was too large to keep, so it cannot be ` +
      'sent again, and the call was not run a second time. To run the tool once more, call it again.',
    data: { reason: 'answer_not_kept', toolName: info.toolName, answeredAt: info.answeredAt, bytes: info.bytes },
  })
}

export interface MayHaveRunErrorInfo {
  readonly toolName: string
  /** `cancelled`: its client cancelled it while it ran; `unanswered`: its session ended before the server answered. */
  readonly why: 'cancelled' | 'unanswered'
}

/**
 * The same tool use again, after its first call was sent but never answered
 * (decision M39): it may have run, so it is not sent a second time — and the
 * resend is told so instead of waiting for an answer that will not come.
 */
export function mayHaveRunError(id: SynthesizableId, info: MayHaveRunErrorInfo): Buffer {
  const what = info.why === 'cancelled' ? 'was cancelled while it ran' : 'got no answer before its session ended'
  return synthesizeError(id, {
    code: ERROR_CODE_RESEND,
    message:
      `This call of tool "${info.toolName}" repeats one that ${what}; it may have run, so it was not ` +
      'sent again. To run the tool once more, call it again.',
    data: { reason: info.why === 'cancelled' ? 'cancelled_may_have_run' : 'unanswered_may_have_run', toolName: info.toolName },
  })
}

export interface JoinLimitErrorInfo {
  readonly toolName: string
  readonly limit: number
}

/** Too many resends already wait in this session for calls still running. */
export function joinLimitError(id: SynthesizableId, info: JoinLimitErrorInfo): Buffer {
  return synthesizeError(id, {
    code: ERROR_CODE_RESEND,
    message:
      `This call of tool "${info.toolName}" repeats one still running, and this session already has ` +
      `${info.limit} such calls waiting. Nothing was sent; call it again once one of them is answered.`,
    data: { reason: 'resend_wait_limit', toolName: info.toolName, limit: info.limit },
  })
}
