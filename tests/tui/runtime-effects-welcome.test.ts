import { describe, expect, test } from 'vitest'
import type { Msg } from '../../src/tui/model.js'
import { createTokenCell, executeEffect, type EffectDeps } from '../../src/tui/runtime-effects.js'

/**
 * The welcome screen's `connect-probe` effect (2026-09-19): a seam call and
 * nothing else — the effect executor never dials the network itself, and
 * three things must never turn into a crash: an absent seam, a seam that
 * refuses, and a seam that throws.
 */

function minimalDeps(overrides: Partial<EffectDeps> = {}): EffectDeps {
  return { dispatch: async () => 0, dispatchOptions: {}, env: {}, token: createTokenCell(), ...overrides }
}

const URL = 'https://box.example:8091'

describe('executeEffect — connect-probe', () => {
  test('ok: the seam’s answer becomes the message, with the url it was asked to probe', async () => {
    const message = await executeEffect(
      { kind: 'connect-probe', url: URL },
      minimalDeps({ probeRemote: async () => ({ ok: true }) }),
    )

    expect(message).toEqual<Msg>({ kind: 'connect-probe-result', url: URL, result: { ok: true } })
  })

  test('a structured refusal from the seam is passed through unchanged', async () => {
    const message = await executeEffect(
      { kind: 'connect-probe', url: URL },
      minimalDeps({ probeRemote: async () => ({ ok: false, message: 'could not reach the remote console' }) }),
    )

    expect(message).toEqual<Msg>({
      kind: 'connect-probe-result',
      url: URL,
      result: { ok: false, message: 'could not reach the remote console' },
    })
  })

  test('a throwing seam never escapes: it becomes an ordinary refusal', async () => {
    const message = await executeEffect(
      { kind: 'connect-probe', url: URL },
      minimalDeps({
        probeRemote: async () => {
          throw new Error('ECONNREFUSED')
        },
      }),
    )

    expect(message).toEqual<Msg>({
      kind: 'connect-probe-result',
      url: URL,
      result: { ok: false, message: 'ECONNREFUSED' },
    })
  })

  test('an absent seam is refused rather than throwing "probeRemote is not a function"', async () => {
    const message = await executeEffect({ kind: 'connect-probe', url: URL }, minimalDeps())

    expect(message?.kind).toBe('connect-probe-result')
    expect(message).toMatchObject({ kind: 'connect-probe-result', url: URL, result: { ok: false } })
  })
})

/**
 * "Remember the last address" (2026-09-20): a successful probe saves the url
 * BEFORE the message goes back to the reducer, so the reopen that follows
 * never races the write — and a failure to save is one stderr line, never a
 * reason to refuse a connection that plainly works.
 */
describe('executeEffect — connect-probe remembers the address on success', () => {
  test('ok: rememberRemote is called with exactly the url that was probed', async () => {
    const remembered: string[] = []
    await executeEffect(
      { kind: 'connect-probe', url: URL },
      minimalDeps({ probeRemote: async () => ({ ok: true }), rememberRemote: async (url) => void remembered.push(url) }),
    )

    expect(remembered).toEqual([URL])
  })

  test('a refused probe never calls rememberRemote at all', async () => {
    const remembered: string[] = []
    await executeEffect(
      { kind: 'connect-probe', url: URL },
      minimalDeps({
        probeRemote: async () => ({ ok: false, message: 'refused' }),
        rememberRemote: async (url) => void remembered.push(url),
      }),
    )

    expect(remembered).toEqual([])
  })

  test('a throwing rememberRemote never stops the console from reopening: the ok result still comes back', async () => {
    const message = await executeEffect(
      { kind: 'connect-probe', url: URL },
      minimalDeps({
        probeRemote: async () => ({ ok: true }),
        rememberRemote: async () => {
          throw new Error('EACCES')
        },
      }),
    )

    expect(message).toEqual<Msg>({ kind: 'connect-probe-result', url: URL, result: { ok: true } })
  })

  test('a failure to remember is one stderr line naming the reason, not the address twice', async () => {
    const stderr = { write: (chunk: string) => (lines.push(chunk), true) }
    const lines: string[] = []
    await executeEffect(
      { kind: 'connect-probe', url: URL },
      minimalDeps({
        probeRemote: async () => ({ ok: true }),
        rememberRemote: async () => {
          throw new Error('disk full')
        },
        stderr,
      }),
    )

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('disk full')
  })

  test('an absent rememberRemote seam is simply not called: no crash, no stderr line', async () => {
    const lines: string[] = []
    const message = await executeEffect(
      { kind: 'connect-probe', url: URL },
      minimalDeps({ probeRemote: async () => ({ ok: true }), stderr: { write: (c: string) => (lines.push(c), true) } }),
    )

    expect(message).toEqual<Msg>({ kind: 'connect-probe-result', url: URL, result: { ok: true } })
    expect(lines).toEqual([])
  })
})
