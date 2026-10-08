import { synthesizeError, type SynthesizableId } from './synthesize.js'

/**
 * Local answers to a resend of a tool use (decision M36, phase C): the same
 * `toolUseId` again, when the plane cannot give it the first result. Split
 * from `synthesize.ts` by topic. Agent-facing UX like every synthesized
 * answer: what happened, and what calling again does.
 */

/** A resend the plane answered itself rather than run the call a second time. */
export const ERROR_CODE_RESEND = -32004

export interface ToolUseInFlightErrorInfo {
  readonly toolName: string
}

/** The same tool use is still held for a human or running at the server under an earlier request. */
export function toolUseInFlightError(id: SynthesizableId, info: ToolUseInFlightErrorInfo): Buffer {
  return synthesizeError(id, {
    code: ERROR_CODE_RESEND,
    message:
      `This call of tool "${info.toolName}" repeats one that an earlier request is still handling ` +
      '(waiting for approval or running at the server). Nothing was sent again; to run the tool ' +
      'once more, call it again.',
    data: { reason: 'tool_use_in_flight', toolName: info.toolName },
  })
}

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
