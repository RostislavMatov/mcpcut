import { describe, expect, test } from 'vitest'
import { SETUP_CODE_PREFIX } from '../../src/admin/constants.js'
import { createSetupGate } from '../../src/ui/setup-gate.js'

/**
 * The first-run gate: what decides whether `/setup` exists at all, and the
 * only holder of the one-time setup code's hash.
 */

function gateOver(state: { admins: number; reads?: number }) {
  return createSetupGate({
    hasAdmins: async () => {
      state.reads = (state.reads ?? 0) + 1
      return state.admins > 0
    },
  })
}

describe('createSetupGate', () => {
  test('is closed until armed, even over an empty store', async () => {
    const gate = gateOver({ admins: 0 })

    expect(await gate.isOpen()).toBe(false)
    expect(gate.verify('anything')).toBe(false)
  })

  test('arming returns a prefixed high-entropy code that verifies, and nothing else does', async () => {
    const gate = gateOver({ admins: 0 })

    const code = gate.arm()

    expect(code.startsWith(SETUP_CODE_PREFIX)).toBe(true)
    expect(code.length).toBeGreaterThanOrEqual(SETUP_CODE_PREFIX.length + 22)
    expect(await gate.isOpen()).toBe(true)
    expect(gate.verify(code)).toBe(true)
    expect(gate.verify(`${code}x`)).toBe(false)
    expect(gate.verify('')).toBe(false)
  })

  test('surrounding whitespace from a copy-paste does not fail a correct code', () => {
    const gate = gateOver({ admins: 0 })
    const code = gate.arm()

    expect(gate.verify(`  ${code}\n`)).toBe(true)
  })

  test('an admin appearing elsewhere (CLI) closes the gate for good and kills the code', async () => {
    const state = { admins: 0, reads: 0 }
    const gate = gateOver(state)
    const code = gate.arm()
    expect(await gate.isOpen()).toBe(true)

    state.admins = 1
    expect(await gate.isOpen()).toBe(false)
    const readsWhenClosed = state.reads

    state.admins = 0
    expect(await gate.isOpen()).toBe(false)
    expect(gate.verify(code)).toBe(false)
    expect(state.reads).toBe(readsWhenClosed)
  })

  test('close() ends the first run: not open, code dead, store no longer asked', async () => {
    const state = { admins: 0, reads: 0 }
    const gate = gateOver(state)
    const code = gate.arm()

    gate.close()

    expect(await gate.isOpen()).toBe(false)
    expect(gate.verify(code)).toBe(false)
    expect(state.reads).toBe(0)
  })

  test('a store that cannot be read is NOT an open first run — and is not a closed one either', async () => {
    let broken = true
    const complaints: unknown[] = []
    const gate = createSetupGate({
      hasAdmins: async () => {
        if (broken) throw new Error('state.db is corrupt')
        return false
      },
      onReadError: (error) => complaints.push(error),
    })
    const code = gate.arm()

    expect(await gate.isOpen()).toBe(false)
    expect(complaints).toHaveLength(1)

    // Fixed store, same process: the first run resumes with the same code.
    broken = false
    expect(await gate.isOpen()).toBe(true)
    expect(gate.verify(code)).toBe(true)
  })

  test('re-arming replaces the code: the old one stops verifying', () => {
    const gate = gateOver({ admins: 0 })
    const first = gate.arm()
    const second = gate.arm()

    expect(first).not.toBe(second)
    expect(gate.verify(first)).toBe(false)
    expect(gate.verify(second)).toBe(true)
  })

  test('a closed gate cannot be re-armed', async () => {
    const gate = gateOver({ admins: 0 })
    gate.arm()
    gate.close()

    expect(() => gate.arm()).toThrow(/closed/)
  })
})
