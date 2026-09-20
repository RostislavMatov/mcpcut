import { describe, expect, test } from 'vitest'
import {
  CONSOLE_API_PREFIX,
  CONSOLE_API_RUN_PATH,
  CONSOLE_API_SETUP_PATH,
  CONSOLE_API_STATE_PATH,
  CONSOLE_API_WHOAMI_PATH,
  MAX_RUN_ARGV_ENTRIES,
  MAX_RUN_ARG_LENGTH,
  MAX_RUN_STDIN_LENGTH,
  consoleErrorSchema,
  consoleRunFrameSchema,
  consoleRunRequestSchema,
  consoleSetupResponseSchema,
  consoleStateSchema,
  consoleWhoamiSchema,
} from '../../src/console-api/contract.js'

describe('console API contract', () => {
  test('every path lives under the one prefix the server branches on', () => {
    const paths = [
      CONSOLE_API_STATE_PATH,
      CONSOLE_API_WHOAMI_PATH,
      CONSOLE_API_SETUP_PATH,
      CONSOLE_API_RUN_PATH,
    ]

    expect(paths.every((path) => path.startsWith(CONSOLE_API_PREFIX))).toBe(true)
  })

  test('a run request needs at least one argv entry', () => {
    expect(consoleRunRequestSchema.safeParse({ argv: [] }).success).toBe(false)
    expect(consoleRunRequestSchema.safeParse({ argv: ['status'] }).success).toBe(true)
  })

  test('a run request refuses an argv beyond its bounds', () => {
    const tooMany = Array.from({ length: MAX_RUN_ARGV_ENTRIES + 1 }, () => 'x')
    const tooLong = ['x'.repeat(MAX_RUN_ARG_LENGTH + 1)]

    expect(consoleRunRequestSchema.safeParse({ argv: tooMany }).success).toBe(false)
    expect(consoleRunRequestSchema.safeParse({ argv: tooLong }).success).toBe(false)
  })

  test('a run request refuses a secret beyond its bound and any unknown key', () => {
    const stdin = 's'.repeat(MAX_RUN_STDIN_LENGTH + 1)

    expect(consoleRunRequestSchema.safeParse({ argv: ['vault', 'set', 'k'], stdin }).success).toBe(false)
    expect(consoleRunRequestSchema.safeParse({ argv: ['status'], token: 't' }).success).toBe(false)
  })

  test('a frame is one of out, err, exit and nothing else', () => {
    expect(consoleRunFrameSchema.safeParse({ t: 'out', d: 'line\n' }).success).toBe(true)
    expect(consoleRunFrameSchema.safeParse({ t: 'err', d: '' }).success).toBe(true)
    expect(consoleRunFrameSchema.safeParse({ t: 'exit', code: 2 }).success).toBe(true)
    expect(consoleRunFrameSchema.safeParse({ t: 'exit', code: 1.5 }).success).toBe(false)
    expect(consoleRunFrameSchema.safeParse({ t: 'exit', code: 0, d: 'x' }).success).toBe(false)
    expect(consoleRunFrameSchema.safeParse({ t: 'token', d: 'x' }).success).toBe(false)
  })

  test('whoami names one of the three fixed roles', () => {
    expect(consoleWhoamiSchema.safeParse({ name: 'kate', role: 'owner' }).success).toBe(true)
    expect(consoleWhoamiSchema.safeParse({ name: 'kate', role: 'root' }).success).toBe(false)
  })

  test('a setup answer without a token is not an answer', () => {
    expect(consoleSetupResponseSchema.safeParse({ name: 'kate', token: '', journaled: true }).success).toBe(false)
    expect(consoleSetupResponseSchema.safeParse({ name: 'kate', token: 'mcpa_x', journaled: false }).success).toBe(true)
  })

  test('state and refusal documents are strict', () => {
    expect(consoleStateSchema.safeParse({ api: 1, firstRun: true }).success).toBe(true)
    expect(consoleStateSchema.safeParse({ api: 1, firstRun: true, admins: [] }).success).toBe(false)
    expect(consoleErrorSchema.safeParse({ error: 'forbidden', message: 'owner only' }).success).toBe(true)
    expect(consoleErrorSchema.safeParse({ error: 'teapot', message: '' }).success).toBe(false)
  })
})
