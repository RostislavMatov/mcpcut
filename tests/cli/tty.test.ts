import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'vitest'
import { isInteractiveTerminal } from '../../src/cli/tty.js'
import type { TuiOutput } from '../../src/tui/runtime.js'
import { createFakeTerminal } from '../tui/support/fake-terminal.js'

/**
 * The one question asked before any console opens (mcpcut phase 3, task 8):
 * is there a terminal to draw on at all. It lives in its own leaf module so
 * that the wizard and `tui` can both ask it without importing each other.
 */

describe('isInteractiveTerminal', () => {
  test('an explicit isTty answers on its own, whatever the terminal is', () => {
    const fake = createFakeTerminal()

    expect(isInteractiveTerminal({ isTty: false, terminal: fake.terminal })).toBe(false)
    expect(isInteractiveTerminal({ isTty: true })).toBe(true)
  })

  test('a terminal whose halves are both a TTY is interactive', () => {
    const fake = createFakeTerminal()

    expect(isInteractiveTerminal({ terminal: fake.terminal })).toBe(true)
  })

  test('one half that is not a TTY is enough to refuse', () => {
    const fake = createFakeTerminal()
    // A redirected stdout: the console reads keys from a terminal it cannot
    // draw on, which is not a console.
    const pipedOutput: TuiOutput = Object.assign(new EventEmitter(), {
      isTTY: false,
      write: (): boolean => true,
    })

    expect(
      isInteractiveTerminal({ terminal: { input: fake.terminal.input, output: pipedOutput } }),
    ).toBe(false)
  })

  test('no options at all falls back to the process streams', () => {
    // Whatever the suite runs on, the answer must be a boolean rather than a
    // throw: `dispatch` calls this on every bare invocation.
    expect(typeof isInteractiveTerminal()).toBe('boolean')
  })
})
