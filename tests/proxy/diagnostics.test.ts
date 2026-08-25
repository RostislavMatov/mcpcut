import { EventEmitter } from 'node:events'
import { PassThrough, type Writable } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { guardDiagnostics } from '../../src/proxy/diagnostics.js'
import { splice } from '../../src/proxy/splice.js'

/**
 * A `process.stderr`-alike whose reader has gone away: every write is
 * accepted and then fails asynchronously with EPIPE, and — exactly like the
 * real stdio streams, whose `destroy` is a no-op — it never becomes
 * `destroyed`, so nothing stops the next write from being dispatched. The
 * error emission is capped so an unguarded feedback loop terminates instead
 * of starving the test's own timers.
 */
function createBrokenPipe(maxErrors = 50): EventEmitter & { write(chunk: unknown): boolean; writes(): number } {
  const emitter = new EventEmitter()
  let writes = 0
  return Object.assign(emitter, {
    writes: () => writes,
    write: (_chunk: unknown): boolean => {
      writes += 1
      if (writes <= maxErrors) {
        process.nextTick(() => emitter.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })))
      }
      return true
    },
  })
}

async function settle(turns = 25): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

describe('guardDiagnostics', () => {
  test('forwards diagnostics while the target is healthy', () => {
    const chunks: unknown[] = []
    const guarded = guardDiagnostics({ write: (chunk: unknown) => chunks.push(chunk) })

    guarded.write('[connect] one\n')
    guarded.write('[connect] two\n')

    expect(chunks).toEqual(['[connect] one\n', '[connect] two\n'])
  })

  test("drops every write after the target has emitted 'error', and never errors itself", async () => {
    const target = createBrokenPipe()
    const guarded = guardDiagnostics(target)
    guarded.on('error', (error) => {
      throw new Error(`guard must stay silent, got ${String(error)}`)
    })

    guarded.write('first\n')
    await settle(2)
    guarded.write('second\n')
    guarded.write('third\n')
    await settle(2)

    expect(target.writes()).toBe(1)
  })

  test('a target whose write throws is treated as gone', () => {
    let calls = 0
    const guarded = guardDiagnostics({
      write: () => {
        calls += 1
        throw new Error('write after end')
      },
    })

    expect(() => guarded.write('a\n')).not.toThrow()
    expect(() => guarded.write('b\n')).not.toThrow()
    expect(calls).toBe(1)
  })

  /**
   * The 2026-08-25 orphan: a `connect` whose client died had its stderr pipe
   * broken; the server-stderr splice reported the EPIPE through a diagnostic
   * written to that same stderr, which failed again, which was reported
   * again — a nextTick loop that never yielded to the event loop (100% CPU,
   * SIGTERM never delivered). Same wiring here: the guard is what bounds it.
   */
  test('reporting a stderr failure to stderr does not loop when diagnostics are guarded', async () => {
    const stderr = createBrokenPipe()
    const diagnostics = guardDiagnostics(stderr)
    const serverStderr = new PassThrough()
    splice(serverStderr, stderr as unknown as Writable, () => undefined, {
      endDestination: false,
      onError: () => {
        diagnostics.write('[connect] server stderr: write EPIPE\n')
      },
    })

    serverStderr.write('m4-server: starting\n')
    await settle()

    expect(stderr.writes()).toBe(1)
  })

  test('control: the same wiring with unguarded diagnostics runs away', async () => {
    const stderr = createBrokenPipe(50)
    const serverStderr = new PassThrough()
    splice(serverStderr, stderr as unknown as Writable, () => undefined, {
      endDestination: false,
      onError: () => {
        stderr.write('[connect] server stderr: write EPIPE\n')
      },
    })

    serverStderr.write('m4-server: starting\n')
    await settle()

    expect(stderr.writes()).toBeGreaterThan(50)
  })
})

describe('wrap routes tap failures through the guarded diagnostics (review HIGH)', () => {
  test('logTapError output lands on `diagnostics`, not on the raw client stderr', async () => {
    const { wireRelay } = await import('../../src/proxy/relay.js')
    const { createRecordBuilder } = await import('../../src/journal/record.js')
    const { PassThrough } = await import('node:stream')
    const clientStderrChunks: string[] = []
    const diagnosticChunks: string[] = []
    const clientStderr = new PassThrough()
    clientStderr.on('data', (chunk: Buffer) => clientStderrChunks.push(chunk.toString('utf8')))
    const diagnostics = guardDiagnostics({ write: (chunk: string) => diagnosticChunks.push(chunk) })
    const serverStderr = new PassThrough()
    const handle = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: serverStderr,
      exitCode: () => new Promise<number>(() => undefined),
      kill: () => true,
    }
    const wiring = wireRelay({
      handle: handle as never,
      clientStdin: new PassThrough(),
      clientStdout: new PassThrough(),
      clientStderr,
      diagnostics,
      recordBuilder: createRecordBuilder('01J0000000000000000000000B'),
      sink: { write: () => { throw new Error('journal tap boom') }, flush: async () => undefined, close: async () => undefined } as never,
      reportError: () => undefined,
      sessionId: '01J0000000000000000000000B',
      policy: undefined,
      serverName: 'm4',
    })

    serverStderr.write('m4-server: starting\n')
    await settle(3)
    wiring.dispose()

    expect(diagnosticChunks.join('')).toContain('journal tap boom')
    expect(clientStderrChunks.join('')).not.toContain('journal tap boom')
  })
})
