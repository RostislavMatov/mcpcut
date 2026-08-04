import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ulid } from 'ulid'
import { createShutdownController, isPipeGoneError, runWrap } from '../../src/proxy/wrap.js'
import type { JournalRecord } from '../../src/journal/record.js'
import {
  BURST_SERVER_PATH,
  DYING_SERVER_PATH,
  FAKE_SERVER_PATH,
  createClientHarness,
  createSlowWritable,
  readJournalRecords,
  requestLine,
  waitUntil,
} from './harness.js'

/**
 * Lifecycle tests for runWrap: shutdown, drain ordering, listener hygiene and
 * stream-error handling. Message relay and journalling behaviour lives in
 * wrap.test.ts.
 */

const SIGKILL_EXIT_CODE = 137 // 128 + 9
const SIGTERM_EXIT_CODE = 143 // 128 + 15
const BURST_RESPONSE_COUNT = 40
const BURST_PADDING_CHARS = 8000
const SLOW_CLIENT_DELAY_MS = 2
const WARNING_SETTLE_MS = 20

/** Counts client→server request records, i.e. how often the client tap fired. */
function countClientRequests(records: readonly JournalRecord[]): number {
  return records.filter((record) => record.direction === 'client→server' && record.kind === 'request')
    .length
}

describe('runWrap lifecycle', () => {
  let journalDir: string

  beforeEach(async () => {
    journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-lifecycle-test-'))
  })

  afterEach(async () => {
    await rm(journalDir, { recursive: true, force: true })
  })

  test('resolves after the child exits even while the client keeps its stdin open', async () => {
    const sessionId = ulid()
    const harness = createClientHarness()

    const runPromise = runWrap('node', [BURST_SERVER_PATH], {
      dir: journalDir,
      sessionId,
      stdin: harness.clientOutbox,
      stdout: harness.clientStdout,
      stderr: harness.clientStderr,
    })
    harness.clientOutbox.write(requestLine(1, 'burst', { count: 1 }))

    // Deliberately never ends clientOutbox: a zombie proxy would hang here.
    await expect(runPromise).resolves.toBe(0)
  })

  test('leaves no residual listeners on the injected client stdin after resolving', async () => {
    const sessionId = ulid()
    const harness = createClientHarness()

    const runPromise = runWrap('node', [BURST_SERVER_PATH], {
      dir: journalDir,
      sessionId,
      stdin: harness.clientOutbox,
      stdout: harness.clientStdout,
      stderr: harness.clientStderr,
    })
    harness.clientOutbox.write(requestLine(1, 'burst', { count: 1 }))
    await runPromise

    expect(harness.clientOutbox.listenerCount('data')).toBe(0)
    expect(harness.clientOutbox.listenerCount('end')).toBe(0)
    expect(harness.clientOutbox.listenerCount('error')).toBe(0)
    expect(harness.clientOutbox.isPaused()).toBe(true)
  })

  test('running twice sequentially over fresh streams leaks no listeners and warns about none', async () => {
    const warnings: string[] = []
    const collectWarning = (warning: Error): void => {
      warnings.push(warning.name)
    }
    process.on('warning', collectWarning)
    const signalListenersBefore = process.listenerCount('SIGTERM')

    try {
      for (let run = 0; run < 2; run += 1) {
        const harness = createClientHarness()
        const runPromise = runWrap('node', [BURST_SERVER_PATH], {
          dir: journalDir,
          sessionId: ulid(),
          stdin: harness.clientOutbox,
          stdout: harness.clientStdout,
          stderr: harness.clientStderr,
        })
        harness.clientOutbox.write(requestLine(1, 'burst', { count: 1 }))
        await runPromise
      }
      await new Promise((resolve) => setTimeout(resolve, WARNING_SETTLE_MS))
    } finally {
      process.removeListener('warning', collectWarning)
    }

    expect(process.listenerCount('SIGTERM')).toBe(signalListenersBefore)
    expect(warnings).not.toContain('MaxListenersExceededWarning')
  })

  test('re-running over the same client streams neither leaks listeners nor double-taps', async () => {
    const harness = createClientHarness()
    const sessionIds = [ulid(), ulid()]

    for (const sessionId of sessionIds) {
      const runPromise = runWrap('node', [BURST_SERVER_PATH], {
        dir: journalDir,
        sessionId,
        stdin: harness.clientOutbox,
        stdout: harness.clientStdout,
        stderr: harness.clientStderr,
      })
      harness.clientOutbox.write(requestLine(1, 'burst', { count: 1 }))
      await runPromise
      expect(harness.clientOutbox.listenerCount('data')).toBe(0)
    }

    // A leaked splice from the first run would keep tapping the shared stdin
    // and append the second run's traffic to the first run's journal.
    const [firstSessionId, secondSessionId] = sessionIds as [string, string]
    const firstRunRecords = await readJournalRecords(journalDir, firstSessionId)
    const secondRunRecords = await readJournalRecords(journalDir, secondSessionId)
    expect(countClientRequests(firstRunRecords)).toBe(1)
    expect(countClientRequests(secondRunRecords)).toBe(1)
  })

  test('a slow-reading client destination receives every server response before runWrap resolves', async () => {
    const sessionId = ulid()
    const harness = createClientHarness()
    const slowClient = createSlowWritable(SLOW_CLIENT_DELAY_MS)

    const runPromise = runWrap('node', [BURST_SERVER_PATH], {
      dir: journalDir,
      sessionId,
      stdin: harness.clientOutbox,
      stdout: slowClient.writable,
      stderr: harness.clientStderr,
    })
    // Padded so the burst outgrows the OS pipe buffer: the child is gone long
    // before the slow client has taken the last of its responses.
    harness.clientOutbox.write(
      requestLine(1, 'burst', { count: BURST_RESPONSE_COUNT, padding: BURST_PADDING_CHARS }),
    )

    await runPromise

    expect(slowClient.receivedLineCount()).toBe(BURST_RESPONSE_COUNT)
  })

  test('a child killed mid-request with stdin still open resolves with the mapped signal code', async () => {
    const sessionId = ulid()
    const harness = createClientHarness()

    const runPromise = runWrap('node', [DYING_SERVER_PATH], {
      dir: journalDir,
      sessionId,
      stdin: harness.clientOutbox,
      stdout: harness.clientStdout,
      stderr: harness.clientStderr,
    })
    harness.clientOutbox.write(requestLine(1, 'tools/list'))

    // clientOutbox stays open on purpose: the client is still connected.
    await expect(runPromise).resolves.toBe(SIGKILL_EXIT_CODE)
  })

  test('flushes a complete journal when the child is killed mid-request', async () => {
    const sessionId = ulid()
    const harness = createClientHarness()

    const runPromise = runWrap('node', [DYING_SERVER_PATH], {
      dir: journalDir,
      sessionId,
      stdin: harness.clientOutbox,
      stdout: harness.clientStdout,
      stderr: harness.clientStderr,
    })
    harness.clientOutbox.write(requestLine(1, 'tools/list'))
    await runPromise

    // Every line parses: the sink was closed after the last queued write.
    const records = await readJournalRecords(journalDir, sessionId)
    expect(records.some((record) => record.direction === 'client→server')).toBe(true)
    expect(records.some((record) => record.direction === 'server-stderr')).toBe(true)
    const journalFile = await stat(join(journalDir, `${sessionId}.jsonl`))
    expect(journalFile.size).toBeGreaterThan(0)
  })

  test('shuts the child down and reports a non-zero code when the client stdout fails', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const sessionId = ulid()
    const harness = createClientHarness()
    const failingStdout = new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        callback(Object.assign(new Error('client is gone'), { code: 'EIO' }))
      },
    })

    try {
      const runPromise = runWrap('node', [FAKE_SERVER_PATH], {
        dir: journalDir,
        sessionId,
        stdin: harness.clientOutbox,
        stdout: failingStdout,
        stderr: harness.clientStderr,
      })
      harness.clientOutbox.write(requestLine(1, 'tools/list'))

      await expect(runPromise).resolves.toBe(SIGTERM_EXIT_CODE)
    } finally {
      stderrSpy.mockRestore()
    }

    const records = await readJournalRecords(journalDir, sessionId)
    expect(records.length).toBeGreaterThan(0)
  })

  test('keeps the child exit code when the client writes into a stdin whose child already exited', async () => {
    const sessionId = ulid()
    const harness = createClientHarness()

    const runPromise = runWrap('node', [BURST_SERVER_PATH], {
      dir: journalDir,
      sessionId,
      stdin: harness.clientOutbox,
      stdout: harness.clientStdout,
      stderr: harness.clientStderr,
    })
    harness.clientOutbox.write(requestLine(1, 'burst', { count: 1 }))
    await waitUntil(() => harness.receivedLineCount() >= 1)

    // The child is exiting; keep pushing traffic at its stdin so the broken
    // pipe is hit while the splices are still live. A broken child stdin is a
    // normal shutdown, never a proxy failure.
    const keepWriting = setInterval(() => {
      harness.clientOutbox.write(requestLine(2, 'tools/list'))
    }, 1)

    try {
      await expect(runPromise).resolves.toBe(0)
    } finally {
      clearInterval(keepWriting)
    }
  })
})

describe('createShutdownController', () => {
  interface KillSpy {
    readonly target: { kill: (signal?: NodeJS.Signals) => void }
    readonly signals: Array<NodeJS.Signals | undefined>
  }

  function createKillSpy(): KillSpy {
    const signals: Array<NodeJS.Signals | undefined> = []
    return { target: { kill: (signal) => void signals.push(signal) }, signals }
  }

  function silenceStderr(): { restore: () => void; lines: string[] } {
    const lines: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk))
      return true
    })
    return { restore: () => spy.mockRestore(), lines }
  }

  test('logs a tap error without failing the run or killing the child', () => {
    const { target, signals } = createKillSpy()
    const stderr = silenceStderr()
    const controller = createShutdownController(target)

    controller.report('client→server', new Error('journal write blew up'), 'tap')
    stderr.restore()

    expect(signals).toEqual([])
    expect(controller.hasFailed()).toBe(false)
    expect(stderr.lines.join('')).toContain('journal write blew up')
  })

  test('treats a broken child stdin as a normal shutdown, not a failure', () => {
    const { target, signals } = createKillSpy()
    const controller = createShutdownController(target)

    controller.report(
      'client→server',
      Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
      'destination',
    )

    expect(signals).toEqual([])
    expect(controller.hasFailed()).toBe(false)
  })

  test('shuts the child down with SIGTERM when a relay stream fails', () => {
    const { target, signals } = createKillSpy()
    const stderr = silenceStderr()
    const controller = createShutdownController(target)

    controller.report('server→client', new Error('client is gone'), 'destination')
    stderr.restore()

    expect(signals).toEqual(['SIGTERM'])
    expect(controller.hasFailed()).toBe(true)
    expect(stderr.lines.join('')).toContain('server→client')
  })

  test('treats a broken pipe on any channel other than the child stdin as a failure', () => {
    const { target, signals } = createKillSpy()
    const stderr = silenceStderr()
    const controller = createShutdownController(target)

    controller.report(
      'server-stderr',
      Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
      'destination',
    )
    stderr.restore()

    expect(signals).toEqual(['SIGTERM'])
    expect(controller.hasFailed()).toBe(true)
  })

  test('treats a source-side failure on the client stdin as a failure', () => {
    const { target, signals } = createKillSpy()
    const stderr = silenceStderr()
    const controller = createShutdownController(target)

    controller.report('client→server', Object.assign(new Error('read EIO'), { code: 'EIO' }), 'source')
    stderr.restore()

    expect(signals).toEqual(['SIGTERM'])
    expect(controller.hasFailed()).toBe(true)
  })

  test('describes a non-Error failure value without throwing', () => {
    const { target } = createKillSpy()
    const stderr = silenceStderr()
    const controller = createShutdownController(target)

    controller.report('server→client', 'plain string failure', 'source')
    stderr.restore()

    expect(stderr.lines.join('')).toContain('plain string failure')
  })
})

describe('isPipeGoneError', () => {
  test.each([
    ['EPIPE', true],
    ['ERR_STREAM_DESTROYED', true],
    ['ERR_STREAM_WRITE_AFTER_END', true],
    ['EIO', false],
    ['ENOENT', false],
  ])('classifies error code %s as pipe-gone=%s', (code, expected) => {
    expect(isPipeGoneError(Object.assign(new Error('boom'), { code }))).toBe(expected)
  })

  test.each([[null], [undefined], ['EPIPE'], [42], [{ code: 'EPIPE' }]])(
    'treats the non-Error value %s as not pipe-gone',
    (value) => {
      expect(isPipeGoneError(value)).toBe(false)
    },
  )

  test('treats an Error without a code as not pipe-gone', () => {
    expect(isPipeGoneError(new Error('no code'))).toBe(false)
  })
})
