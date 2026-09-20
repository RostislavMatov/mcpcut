import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'vitest'
import { dispatch, type CliIo } from '../../src/cli.js'
import type { DataDirResolution } from '../../src/setup/data-dir.js'
import { plainStyle } from '../../src/tui/ansi.js'
import { createFakeTerminal, waitForScreen } from '../tui/support/fake-terminal.js'

/**
 * `mcpcut --connect [url]` (ADR-0014, owner request 2026-09-20): the
 * top-level entry `cli.ts` routes BEFORE the broken-config gate, same
 * reasoning as `--remote` (`dispatch-remote.test.ts`) — but the address is
 * optional, and a bad one is a notice on the form rather than a refusal.
 */

interface FakeIo extends CliIo {
  err(): string
}

function fakeIo(): FakeIo {
  const errChunks: string[] = []
  return {
    stdout: { write: () => undefined },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    err: () => errChunks.join(''),
  }
}

/** A local install resolution broken enough that the ordinary gate would refuse it. */
const BROKEN_INSTALL: DataDirResolution = {
  dataDir: '/home/op/.mcpcut/data',
  source: 'default',
  configPath: '/home/op/.mcpcut/config.json',
  problem: ['dataDir: dataDir must be an absolute path'],
  problemSource: 'config',
}

describe('dispatch: --connect is documented', () => {
  test('--help names the flag, right beside --remote', async () => {
    const io = fakeIo()
    const outChunks: string[] = []
    const outIo: CliIo = { stdout: { write: (chunk: string) => outChunks.push(chunk) }, stderr: io.stderr }

    await dispatch(['--help'], outIo, {})

    const text = outChunks.join('')
    expect(text).toContain('--connect [url]')
    expect(text).toContain('--remote <url>')
  })
})

describe('dispatch: --connect', () => {
  test('with no URL, opens the connect form even over a broken local install', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = dispatch(['--connect'], io, {
      install: BROKEN_INSTALL,
      tui: { isTty: true, terminal: fake.terminal, style: plainStyle, processEvents: new EventEmitter(), escapeCodeTimeoutMs: 10 },
    })
    await waitForScreen(fake, (screen) => screen.includes('Host:'), 'the connect form')
    fake.type('\x03')

    expect(await running).toBe(0)
    expect(io.err()).toBe('')
  })

  test('with a URL, it prefills the form', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = dispatch(['--connect', 'https://box.example:8091'], io, {
      tui: { isTty: true, terminal: fake.terminal, style: plainStyle, processEvents: new EventEmitter(), escapeCodeTimeoutMs: 10 },
    })
    await waitForScreen(fake, (screen) => screen.includes('box.example'), 'the prefilled host')
    fake.type('\x03')

    expect(await running).toBe(0)
  })

  test('a bad URL is a notice on the form, never a refusal', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const running = dispatch(['--connect', 'ftp://example.com'], io, {
      tui: { isTty: true, terminal: fake.terminal, style: plainStyle, processEvents: new EventEmitter(), escapeCodeTimeoutMs: 10 },
    })
    await waitForScreen(fake, (screen) => screen.includes('Host:'), 'the connect form')
    const text = fake.screen()
    fake.type('\x03')

    expect(await running).toBe(0)
    expect(text).toContain('ftp://example.com')
  })

  test('extra arguments after the URL are refused the same way tui refuses them', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const code = await dispatch(['--connect', 'https://box.example:8091', 'extra'], io, {
      tui: { isTty: true, terminal: fake.terminal },
    })

    expect(code).toBe(1)
    expect(io.err()).toContain('tui takes no arguments')
  })

  test('a value that looks like another flag is not swallowed as the url', async () => {
    const io = fakeIo()
    const fake = createFakeTerminal()

    const code = await dispatch(['--connect', '--help'], io, {
      tui: { isTty: true, terminal: fake.terminal },
    })

    expect(code).toBe(0)
    expect(io.err()).toBe('')
  })
})
