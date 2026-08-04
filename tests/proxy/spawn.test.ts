import { describe, expect, test } from 'vitest'
import { DEFAULT_FORWARDED_SIGNALS, installSignalForwarding, spawnServer } from '../../src/proxy/spawn.js'

const SIGTERM_EXIT_CODE = 143 // 128 + 15
const CHILD_STARTUP_GRACE_MS = 50

/** Waits a short, fixed grace period for a just-spawned child to be ready to receive signals. */
function waitForChildStartup(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, CHILD_STARTUP_GRACE_MS))
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

  test('exposes piped stdin, stdout and stderr streams and a pid', () => {
    const handle = spawnServer('node', ['-e', ''])

    expect(handle.stdin.writable).toBe(true)
    expect(handle.stdout.readable).toBe(true)
    expect(handle.stderr.readable).toBe(true)
    expect(typeof handle.pid).toBe('number')
  })
})

describe('installSignalForwarding', () => {
  test('forwards a configured signal to the target', () => {
    const received: NodeJS.Signals[] = []
    const target = {
      kill: (signal?: NodeJS.Signals) => {
        received.push(signal ?? 'SIGTERM')
      },
    }

    const handle = installSignalForwarding(target, ['SIGTERM'])
    try {
      process.emit('SIGTERM')
      expect(received).toEqual(['SIGTERM'])
    } finally {
      handle.uninstall()
    }
  })

  test('uninstall removes exactly the listeners it added, restoring prior listener counts', () => {
    const target = { kill: () => undefined }
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
      const target = { kill: () => undefined }
      const handle = installSignalForwarding(target, ['SIGTERM'])

      handle.uninstall()

      expect(process.listeners('SIGTERM')).toContain(otherListener)
    } finally {
      process.removeListener('SIGTERM', otherListener)
    }
  })
})
