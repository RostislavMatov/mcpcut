import { describe, expect, test } from 'vitest'
import {
  MAX_KEPT_ANSWER_BYTES,
  TOOL_USE_ANSWER_TTL_MS,
  TOOL_USE_CLAIM_MAX_AGE_MS,
  createToolUseAnswers,
} from '../../src/proxy/tool-use-answers.js'

const IDENTITY = { serverName: 'fs', toolName: 'write_file', argsHash: 'h1' }
const RESPONSE = '{"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"ok"}]}}'

function clockAt(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start
  return { now: () => at, advance: (ms) => (at += ms) }
}

describe('tool-use answers: the server answer a resend of the same tool use gets (M36 phase C)', () => {
  test('a kept answer is found again by agent, tool-use id and the same call', () => {
    // Arrange
    const answers = createToolUseAnswers({ clock: clockAt().now })

    // Act
    const outcome = answers.keep('bot', 'toolu_1', { ...IDENTITY, response: RESPONSE, delivered: false })
    const found = answers.find('bot', 'toolu_1', IDENTITY)

    // Assert
    expect(outcome).toBe('kept')
    expect(found?.response).toBe(RESPONSE)
    expect(found?.delivered).toBe(false)
  })

  test('another agent, another tool use or another call under the same id finds nothing', () => {
    const answers = createToolUseAnswers({ clock: clockAt().now })
    answers.keep('bot', 'toolu_1', { ...IDENTITY, response: RESPONSE, delivered: true })

    expect(answers.find('other-bot', 'toolu_1', IDENTITY)).toBeNull()
    expect(answers.find('bot', 'toolu_2', IDENTITY)).toBeNull()
    expect(answers.find('bot', 'toolu_1', { ...IDENTITY, argsHash: 'h2' })).toBeNull()
    expect(answers.find('bot', 'toolu_1', { ...IDENTITY, toolName: 'read_file' })).toBeNull()
    expect(answers.find('bot', 'toolu_1', { ...IDENTITY, serverName: 'git' })).toBeNull()
    // A mismatch does not throw the kept answer away.
    expect(answers.find('bot', 'toolu_1', IDENTITY)?.response).toBe(RESPONSE)
  })

  test('an answer is kept for 24 hours and no longer', () => {
    const clock = clockAt()
    const answers = createToolUseAnswers({ clock: clock.now })
    answers.keep('bot', 'toolu_1', { ...IDENTITY, response: RESPONSE, delivered: false })

    clock.advance(TOOL_USE_ANSWER_TTL_MS - 1)
    expect(answers.find('bot', 'toolu_1', IDENTITY)).not.toBeNull()
    clock.advance(1)
    expect(answers.find('bot', 'toolu_1', IDENTITY)).toBeNull()
  })

  test('an answer over the per-answer limit is not kept', () => {
    const answers = createToolUseAnswers({ clock: clockAt().now })
    const huge = `{"jsonrpc":"2.0","id":1,"result":"${'x'.repeat(MAX_KEPT_ANSWER_BYTES)}"}`

    expect(answers.keep('bot', 'toolu_1', { ...IDENTITY, response: huge, delivered: false })).toBe('too-large')
    expect(answers.find('bot', 'toolu_1', IDENTITY)).toBeNull()
  })

  test('past the total limit delivered answers leave first, then the oldest', () => {
    // Arrange: room for exactly three answers of this size.
    const size = Buffer.byteLength(RESPONSE)
    const answers = createToolUseAnswers({ clock: clockAt().now, maxTotalBytes: size * 3 })
    answers.keep('bot', 'undelivered-old', { ...IDENTITY, response: RESPONSE, delivered: false })
    answers.keep('bot', 'delivered', { ...IDENTITY, response: RESPONSE, delivered: true })
    answers.keep('bot', 'undelivered-mid', { ...IDENTITY, response: RESPONSE, delivered: false })

    // Act: a fourth pushes one out — the delivered one, though it is not the oldest.
    answers.keep('bot', 'undelivered-new', { ...IDENTITY, response: RESPONSE, delivered: false })

    // Assert
    expect(answers.find('bot', 'delivered', IDENTITY)).toBeNull()
    expect(answers.find('bot', 'undelivered-old', IDENTITY)).not.toBeNull()

    // A fifth, with no delivered answer left: the oldest goes.
    answers.keep('bot', 'undelivered-newest', { ...IDENTITY, response: RESPONSE, delivered: false })
    expect(answers.find('bot', 'undelivered-old', IDENTITY)).toBeNull()
    expect(answers.find('bot', 'undelivered-mid', IDENTITY)).not.toBeNull()
    expect(answers.find('bot', 'undelivered-newest', IDENTITY)).not.toBeNull()
  })

  test('keeping the same tool use again replaces its answer', () => {
    const answers = createToolUseAnswers({ clock: clockAt().now })
    answers.keep('bot', 'toolu_1', { ...IDENTITY, response: RESPONSE, delivered: false })
    answers.keep('bot', 'toolu_1', { ...IDENTITY, response: '{"jsonrpc":"2.0","id":8,"result":{}}', delivered: true })

    expect(answers.find('bot', 'toolu_1', IDENTITY)).toMatchObject({ response: '{"jsonrpc":"2.0","id":8,"result":{}}', delivered: true })
  })
})

describe('tool-use answers: one call per tool use at a time', () => {
  test('a tool use claimed by one call cannot be claimed by another until released', () => {
    const answers = createToolUseAnswers({ clock: clockAt().now })

    const first = answers.claim('bot', 'toolu_1')
    expect(first).not.toBeNull()
    expect(answers.claim('bot', 'toolu_1')).toBeNull()
    // Another agent's tool use of the same name is its own.
    expect(answers.claim('other-bot', 'toolu_1')).not.toBeNull()

    first?.release()
    expect(answers.claim('bot', 'toolu_1')).not.toBeNull()
  })

  test('a claim nobody released lapses after the longest a call can be held', () => {
    const clock = clockAt()
    const answers = createToolUseAnswers({ clock: clock.now })
    answers.claim('bot', 'toolu_1')

    clock.advance(TOOL_USE_CLAIM_MAX_AGE_MS - 1)
    expect(answers.claim('bot', 'toolu_1')).toBeNull()
    clock.advance(1)
    expect(answers.claim('bot', 'toolu_1')).not.toBeNull()
  })

  test('a lapsed claim released late does not free the claim that replaced it', () => {
    const clock = clockAt()
    const answers = createToolUseAnswers({ clock: clock.now })
    const stale = answers.claim('bot', 'toolu_1')
    clock.advance(TOOL_USE_CLAIM_MAX_AGE_MS)
    const fresh = answers.claim('bot', 'toolu_1')

    stale?.release()

    expect(fresh).not.toBeNull()
    expect(answers.claim('bot', 'toolu_1')).toBeNull()
  })

  test('releasing twice changes nothing', () => {
    const answers = createToolUseAnswers({ clock: clockAt().now })
    const claim = answers.claim('bot', 'toolu_1')
    claim?.release()
    const next = answers.claim('bot', 'toolu_1')

    claim?.release()

    expect(next).not.toBeNull()
    expect(answers.claim('bot', 'toolu_1')).toBeNull()
  })
})
