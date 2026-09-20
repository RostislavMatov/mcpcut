import { describe, expect, test } from 'vitest'
import { createReopenCell, createTokenCell, executeEffect, type EffectDeps } from '../../src/tui/runtime-effects.js'

/**
 * The `disconnect` effect (2026-09-20, owner request "a way to disconnect"):
 * forgets the saved address, then hands the terminal to `--connect <address>`
 * — never a crash, and never blocked by a failure to forget.
 */

function minimalDeps(overrides: Partial<EffectDeps> = {}): EffectDeps {
  return { dispatch: async () => 0, dispatchOptions: {}, env: {}, token: createTokenCell(), ...overrides }
}

const ARGV = ['--connect', 'https://box.example:8091']

describe('executeEffect — disconnect', () => {
  test('calls forgetRemote and sets the reopen cell to the given argv', async () => {
    const reopen = createReopenCell()
    let forgotten = false

    const message = await executeEffect(
      { kind: 'disconnect', argv: ARGV },
      minimalDeps({ forgetRemote: async () => void (forgotten = true), reopen }),
    )

    expect(forgotten).toBe(true)
    expect(reopen.get()).toEqual(ARGV)
    expect(message).toBeUndefined()
  })

  test('a throwing forgetRemote still reopens: one stderr line, never a reason to stay connected', async () => {
    const reopen = createReopenCell()
    const lines: string[] = []

    await executeEffect(
      { kind: 'disconnect', argv: ARGV },
      minimalDeps({
        forgetRemote: async () => {
          throw new Error('EACCES')
        },
        reopen,
        stderr: { write: (chunk: string) => (lines.push(chunk), true) },
      }),
    )

    expect(reopen.get()).toEqual(ARGV)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('EACCES')
  })

  test('an absent forgetRemote seam still reopens without crashing', async () => {
    const reopen = createReopenCell()

    await executeEffect({ kind: 'disconnect', argv: ARGV }, minimalDeps({ reopen }))

    expect(reopen.get()).toEqual(ARGV)
  })

  test('an absent reopen cell (the unit harness) does not throw', async () => {
    await expect(
      executeEffect({ kind: 'disconnect', argv: ARGV }, minimalDeps({ forgetRemote: async () => undefined })),
    ).resolves.toBeUndefined()
  })

  test('the argv is copied: mutating the effect afterwards does not change what was reopened', async () => {
    const reopen = createReopenCell()
    const argv = [...ARGV]

    await executeEffect({ kind: 'disconnect', argv }, minimalDeps({ reopen }))
    argv.push('extra')

    expect(reopen.get()).toEqual(ARGV)
  })
})
