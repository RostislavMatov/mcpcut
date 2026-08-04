import { once } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_FORWARDED_SIGNALS,
  installSignalForwarding,
  mapExitCode,
  spawnServer,
  type ServerHandle,
} from '../../src/proxy/spawn.js'

const SIGTERM_EXIT_CODE = 143 // 128 + 15
const SIGKILL_EXIT_CODE = 137 // 128 + 9
const SIGNAL_EXIT_CODE_BASE = 128
const CHILD_STARTUP_GRACE_MS = 50
const BURST_RESPONSE_COUNT = 40
const BURST_PADDING_CHARS = 8000
const SLOW_READER_DELAY_MS = 5
const SHORT_ESCALATION_MS = 30
const ESCALATION_SETTLE_MARGIN_MS = 40

/** Waits a short, fixed grace period for a just-spawned child to be ready to receive signals. */
function waitForChildStartup(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, CHILD_STARTUP_GRACE_MS))
}

/** A minimal installSignalForwarding target that never reports an exit, for listener-hygiene tests. */
function stubTarget(kill: (signal?: NodeJS.Signals) => void): Pick<ServerHandle, 'kill' | 'exitCode'> {
  return { kill, exitCode: () => new Promise<number>(() => undefined) }
}

/**
 * Spawns a child that installs a SIGTERM handler ignoring the signal, then
 * writes one byte to stdout as a readiness signal. Waiting for that byte —
 * rather than a fixed grace period — deterministically guarantees the
 * handler is registered before the test delivers a real SIGTERM.
 */
function spawnSignalIgnoringChild(): ServerHandle {
  const handle = spawnServer('node', [
    '-e',
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready')",
  ])
  return handle
}

describe('spawnServer', () => {
  test('propagates a clean non-zero numeric exit code', async () => {
    const handle = spawnServer('node', ['-e', 'process.exit(3)'])

    await expect(handle.exitCode()).resolves.toBe(3)
  })

  test('resolves exit code 0 for a graceful process end', async () => {
    const handle = spawnServer('node', ['-e', ''])

    await expect(handle.exitCode()).resolves.toBe(0)
  })

  test('maps a signal kill to the conventional 128+signal exit code', async () => {
    const handle = spawnServer('node', ['-e', 'setInterval(() => {}, 1000)'])
    await waitForChildStartup()

    handle.kill('SIGTERM')

    await expect(handle.exitCode()).resolves.toBe(SIGTERM_EXIT_CODE)
  })

  test('surfaces ENOENT as a clear rejected error, not an unhandled rejection', async () => {
    const handle = spawnServer('this-binary-should-not-exist-xyz-123', ['--flag'])

    await expect(handle.exitCode()).rejects.toThrow(/this-binary-should-not-exist-xyz-123/)
  })

  test('exitCode() can be awaited multiple times after an ENOENT rejection', async () => {
    const handle = spawnServer('this-binary-should-not-exist-xyz-123', [])

    await expect(handle.exitCode()).rejects.toBeInstanceOf(Error)
    await expect(handle.exitCode()).rejects.toBeInstanceOf(Error)
  })

  test('inherits process.env as-is for the child', async () => {
    const envVarName = 'MCP_JOURNAL_TEST_VAR'
    process.env[envVarName] = 'proxy-test-value'

    try {
      const handle = spawnServer('node', [
        '-e',
        `process.stdout.write(process.env.${envVarName} ?? '')`,
      ])
      const chunks: Buffer[] = []
      handle.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))

      await handle.exitCode()

      expect(Buffer.concat(chunks).toString('utf8')).toBe('proxy-test-value')
    } finally {
      delete process.env[envVarName]
    }
  })

  test('resolves only after a slow reader has drained every byte the child wrote', async () => {
    // The burst is far larger than the OS pipe buffer, so at the moment the
    // child exits a slow reader still has unread bytes queued behind it.
    const script =
      `const padding = 'p'.repeat(${BURST_PADDING_CHARS});` +
      `const burst = Array.from({ length: ${BURST_RESPONSE_COUNT} }, (_u, i) => JSON.stringify({ id: i, padding }) + '\\n').join('');` +
      `process.stdout.write(burst, () => process.exit(0));`
    const handle = spawnServer('node', ['-e', script])
    const chunks: Buffer[] = []
    handle.stderr.resume()
    handle.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      handle.stdout.pause()
      setTimeout(() => handle.stdout.resume(), SLOW_READER_DELAY_MS)
    })

    await handle.exitCode()

    const receivedLines = Buffer.concat(chunks)
      .toString('utf8')
      .split('\n')
      .filter((line) => line.length > 0)
    expect(receivedLines).toHaveLength(BURST_RESPONSE_COUNT)
  })

  test('exposes piped stdin, stdout and stderr streams and a pid', () => {
    const handle = spawnServer('node', ['-e', ''])

    expect(handle.stdin.writable).toBe(true)
    expect(handle.stdout.readable).toBe(true)
    expect(handle.stderr.readable).toBe(true)
    expect(typeof handle.pid).toBe('number')
  })
})

describe('mapExitCode', () => {
  test('maps a clean numeric exit code through unchanged', () => {
    expect(mapExitCode(3, null)).toBe(3)
  })

  test('defaults to 0 when neither a code nor a signal is reported', () => {
    expect(mapExitCode(null, null)).toBe(0)
  })

  test('maps a known signal to 128 + its number', () => {
    expect(mapExitCode(null, 'SIGKILL')).toBe(SIGNAL_EXIT_CODE_BASE + 9)
  })

  test('never returns NaN for a signal this platform does not define', () => {
    const platformAbsentSignal = 'SIGPWR' as NodeJS.Signals

    const exitCode = mapExitCode(null, platformAbsentSignal)

    expect(Number.isNaN(exitCode)).toBe(false)
    expect(exitCode).toBeGreaterThanOrEqual(SIGNAL_EXIT_CODE_BASE)
  })
})

describe('installSignalForwarding', () => {
  test('forwards a configured signal to the target', () => {
    const received: NodeJS.Signals[] = []
    const target = stubTarget((signal) => {
      received.push(signal ?? 'SIGTERM')
    })

    const handle = installSignalForwarding(target, ['SIGTERM'])
    try {
      process.emit('SIGTERM')
      expect(received).toEqual(['SIGTERM'])
    } finally {
      handle.uninstall()
    }
  })

  test('uninstall removes exactly the listeners it added, restoring prior listener counts', () => {
    const target = stubTarget(() => undefined)
    const before = DEFAULT_FORWARDED_SIGNALS.map((signal) => process.listenerCount(signal))

    const handle = installSignalForwarding(target)
    DEFAULT_FORWARDED_SIGNALS.forEach((signal, index) => {
      expect(process.listenerCount(signal)).toBe((before[index] ?? 0) + 1)
    })

    handle.uninstall()
    DEFAULT_FORWARDED_SIGNALS.forEach((signal, index) => {
      expect(process.listenerCount(signal)).toBe(before[index] ?? 0)
    })
  })

  test('uninstall leaves other, pre-existing listeners on the same signal untouched', () => {
    const otherListener = (): void => undefined
    process.on('SIGTERM', otherListener)

    try {
      const target = stubTarget(() => undefined)
      const handle = installSignalForwarding(target, ['SIGTERM'])

      handle.uninstall()

      expect(process.listeners('SIGTERM')).toContain(otherListener)
    } finally {
      process.removeListener('SIGTERM', otherListener)
    }
  })

  test('escalates to SIGKILL after the grace period when the child ignores the forwarded signal', async () => {
    const handle = spawnSignalIgnoringChild()
    await once(handle.stdout, 'data')

    const signalHandle = installSignalForwarding(handle, ['SIGTERM'], {
      killEscalationMs: SHORT_ESCALATION_MS,
    })
    try {
      process.emit('SIGTERM')
      await expect(handle.exitCode()).resolves.toBe(SIGKILL_EXIT_CODE)
    } finally {
      signalHandle.uninstall()
    }
  })

  test('does not escalate once the child has already exited', async () => {
    const handle = spawnServer('node', ['-e', ''])
    const killSpy = vi.spyOn(handle, 'kill')
    await handle.exitCode()

    const signalHandle = installSignalForwarding(handle, ['SIGTERM'], {
      killEscalationMs: SHORT_ESCALATION_MS,
    })
    process.emit('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, SHORT_ESCALATION_MS + ESCALATION_SETTLE_MARGIN_MS))
    signalHandle.uninstall()

    expect(killSpy).toHaveBeenCalledWith('SIGTERM')
    expect(killSpy).not.toHaveBeenCalledWith('SIGKILL')
  })

  test('uninstall cancels a pending escalation so it never fires', async () => {
    const handle = spawnSignalIgnoringChild()
    await once(handle.stdout, 'data')
    const killSpy = vi.spyOn(handle, 'kill')

    const signalHandle = installSignalForwarding(handle, ['SIGTERM'], {
      killEscalationMs: SHORT_ESCALATION_MS,
    })
    process.emit('SIGTERM')
    signalHandle.uninstall()
    await new Promise((resolve) => setTimeout(resolve, SHORT_ESCALATION_MS + ESCALATION_SETTLE_MARGIN_MS))

    expect(killSpy).toHaveBeenCalledWith('SIGTERM')
    expect(killSpy).not.toHaveBeenCalledWith('SIGKILL')

    handle.kill('SIGKILL')
  })
})
