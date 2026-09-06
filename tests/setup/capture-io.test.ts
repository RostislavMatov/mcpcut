import { describe, expect, test } from 'vitest'
import { captureBothIo, captureIo } from '../../src/setup/capture-io.js'

/**
 * `captureIo` answers a preflight row: it folds a refusal onto one line and
 * throws stdout away. The console needs the opposite -- both streams, byte for
 * byte, so the output pane can show what the command actually printed -- which
 * is why `captureBothIo` sits next to it rather than replacing it.
 */

describe('captureBothIo', () => {
  test('keeps what was written to each stream, separately and verbatim', () => {
    const captured = captureBothIo()

    captured.io.stdout.write('admin: bob\n')
    captured.io.stderr.write('warning: no admins\n')
    captured.io.stdout.write('role: operator\n')

    expect(captured.out()).toBe('admin: bob\nrole: operator\n')
    expect(captured.err()).toBe('warning: no admins\n')
  })

  test('returns empty strings for a command that printed nothing', () => {
    const captured = captureBothIo()

    expect(captured.out()).toBe('')
    expect(captured.err()).toBe('')
  })

  test('does not fold or trim the text, unlike the preflight capsule', () => {
    const captured = captureBothIo()

    captured.io.stderr.write('  first issue\n\nsecond issue\n')

    expect(captured.err()).toBe('  first issue\n\nsecond issue\n')
  })

  test('gives each capsule its own buffers', () => {
    const first = captureBothIo()
    const second = captureBothIo()

    first.io.stdout.write('first\n')

    expect(second.out()).toBe('')
  })
})

describe('captureIo', () => {
  test('still folds stderr onto one line and discards stdout', () => {
    const captured = captureIo()

    captured.io.stdout.write('ignored\n')
    captured.io.stderr.write('first issue\n')
    captured.io.stderr.write('second issue\n')

    expect(captured.problems()).toBe('first issue; second issue')
  })
})

describe('captureBothIo with a limit', () => {
  test('drops a write that would pass the limit and remembers that it did', () => {
    const captured = captureBothIo(5)

    captured.io.stdout.write('abc')
    captured.io.stdout.write('def')
    captured.io.stderr.write('e')

    expect(captured.out()).toBe('abc')
    expect(captured.err()).toBe('e')
    expect(captured.truncated()).toBe(true)
  })

  test('is not truncated while the writes fit', () => {
    const captured = captureBothIo(5)

    captured.io.stdout.write('abcde')

    expect(captured.out()).toBe('abcde')
    expect(captured.truncated()).toBe(false)
  })
})
