import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, test } from 'vitest'
import type { AdminRecord } from '../../src/admin/store.js'
import type { ConsoleRunner } from '../../src/console-api/runner.js'
import type { AdminResolver, LoginRateLimiter } from '../../src/ui/auth.js'
import { handleConsoleRun, type ConsoleRunDeps } from '../../src/ui/console-run.js'

/**
 * Review finding 3 (MEDIUM): `handleConsoleRun`'s own backpressure and
 * disconnect handling (`onceDrainOrSettled`, `consoleFrameWritable`) had no
 * test of its own — only the streaming SHAPE was pinned in
 * `tests/ui/console-run.test.ts`, never a response that actually reports
 * `write() === false`, nor a peer that goes away mid-run.
 *
 * A real HTTP round trip cannot reliably force `ServerResponse.write` to
 * return `false` in a unit test (that needs a genuinely full socket buffer,
 * which is timing-dependent), so this suite calls `handleConsoleRun` directly
 * against a fake `IncomingMessage`/`ServerResponse` it controls completely —
 * the same technique `node:http`'s own test suite uses for this exact
 * problem. The fake honours the same event/method surface `console-run.ts`
 * actually touches: `write`, `writeHead`, `end`, `destroy`, `writableEnded`,
 * `destroyed`, and `once`/`off` for `'drain'`/`'close'`/`'error'`.
 */

class FakeServerResponse extends EventEmitter {
  writableEnded = false
  destroyed = false
  readonly writes: string[] = []
  headWritten: { readonly status: number; readonly headers: Record<string, string> } | undefined
  private readonly forcedWriteResults: boolean[] = []

  writeHead(status: number, headers: Record<string, string>): void {
    this.headWritten = { status, headers }
  }

  write(chunk: string): boolean {
    this.writes.push(chunk)
    return this.forcedWriteResults.shift() ?? true
  }

  end(chunk?: string): void {
    if (chunk !== undefined) this.writes.push(chunk)
    this.writableEnded = true
  }

  destroy(): void {
    this.destroyed = true
    this.emit('close')
  }

  /** The NEXT call to `write` reports this instead of `true`. */
  forceNextWrite(result: boolean): void {
    this.forcedWriteResults.push(result)
  }
}

function fakeRequest(body: unknown): IncomingMessage {
  const stream = new PassThrough()
  const req = stream as unknown as IncomingMessage
  Object.assign(req, {
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  })
  stream.end(JSON.stringify(body))
  return req
}

const OWNER: AdminRecord = {
  name: 'alice',
  role: 'owner',
  tokenHash: 'x'.repeat(64),
  createdAt: '2026-09-19T00:00:00.000Z',
}

function alwaysAllow(): LoginRateLimiter {
  return {
    allow: () => true,
    penaltyMs: () => 0,
    recordFailure: () => undefined,
    recordSuccess: () => undefined,
    recordAuthenticated: () => undefined,
  }
}

function storeResolving(token: string, admin: AdminRecord): AdminResolver {
  return {
    findAdminByToken: async (candidate) => (candidate === token ? admin : undefined),
    getActiveAdmin: async () => admin,
  }
}

function depsFor(runner: ConsoleRunner): ConsoleRunDeps {
  return {
    adminStore: storeResolving('tok', OWNER),
    rateLimiter: alwaysAllow(),
    behindTls: false,
    maxBodyBytes: 65_536,
    runner,
    stderr: { write: () => undefined },
  }
}

/** Lets already-queued microtasks/timers run once, without a fixed sleep. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('backpressure: a stdout write reporting false parks until the response drains', () => {
  test('the runner\'s second write happens only after the response emits `drain`', async () => {
    const res = new FakeServerResponse()
    const req = fakeRequest({ argv: ['status'] })
    let observedFirstWrite: boolean | undefined
    let resumed = false

    const runner: ConsoleRunner = async (_request, io) => {
      res.forceNextWrite(false)
      observedFirstWrite = io.stdout.write('first chunk')
      await new Promise<void>((resolve) => io.stdout.once?.('drain', resolve))
      resumed = true
      io.stdout.write('second chunk')
      return 0
    }

    const handled = handleConsoleRun(req, res as unknown as ServerResponse, depsFor(runner))
    await tick()
    await tick()

    expect(observedFirstWrite).toBe(false)
    expect(resumed).toBe(false)
    expect(res.writes.some((chunk) => chunk.includes('second chunk'))).toBe(false)

    res.emit('drain')
    await handled

    expect(resumed).toBe(true)
    expect(res.writes.some((chunk) => chunk.includes('second chunk'))).toBe(true)
    expect(res.writes.at(-1)).toBe(`${JSON.stringify({ t: 'exit', code: 0 })}\n`)
  })
})

describe('disconnect: a destroyed response releases a parked write instead of hanging', () => {
  test('the run ends cleanly, with no exit frame written to the dead connection and no hang', async () => {
    const res = new FakeServerResponse()
    const req = fakeRequest({ argv: ['status'] })
    let resumed = false
    let ranToCompletion = false

    const runner: ConsoleRunner = async (_request, io) => {
      res.forceNextWrite(false)
      io.stdout.write('parked')
      await new Promise<void>((resolve) => io.stdout.once?.('drain', resolve))
      resumed = true
      return 0
    }

    const handled = handleConsoleRun(req, res as unknown as ServerResponse, depsFor(runner)).then(() => {
      ranToCompletion = true
    })
    await tick()
    await tick()
    expect(resumed).toBe(false)

    res.destroy()
    await handled

    expect(resumed).toBe(true)
    expect(ranToCompletion).toBe(true)
    // The peer is gone: `endWithExit` must not have written past `destroy()`.
    expect(res.writes.some((chunk) => chunk.includes('"t":"exit"'))).toBe(false)
  })

  test('a response already ended/destroyed before a write is asked for releases on the next microtask, not never', async () => {
    const res = new FakeServerResponse()
    const req = fakeRequest({ argv: ['status'] })
    let released = false

    const runner: ConsoleRunner = async (_request, io) => {
      res.destroy()
      await new Promise<void>((resolve) => {
        io.stdout.once?.('drain', () => {
          released = true
          resolve()
        })
      })
      return 0
    }

    await handleConsoleRun(req, res as unknown as ServerResponse, depsFor(runner))

    expect(released).toBe(true)
  })
})
