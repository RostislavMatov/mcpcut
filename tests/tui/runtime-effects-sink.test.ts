import type { WriteStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { savedToLine } from '../../src/tui/constants.js'
import {
  exclusiveStream,
  type SinkStreamFactory,
  type SinkWritable,
} from '../../src/tui/run-sink.js'
import { executeEffect } from '../../src/tui/runtime-effects.js'
import {
  depsOf,
  disposeEffectsJournalDir,
  exportRequest,
  journalDirOf,
  openEffectsJournalDir,
  recordingDispatch,
  runResultOf,
  signedInCell,
} from './support/effects-harness.js'

/**
 * The file sink of a `run` (phase 4, task 8): a `stdoutPath` sends the
 * command's stdout to a file created `wx` at 0600 and the pane shows a
 * one-line receipt; every way the file can refuse is an ordinary failed run
 * with nothing dispatched, and a write failure under a parked command still
 * answers (phase 4 review, H1). Split out of `runtime-effects.test.ts`
 * (phase 6, task 9); the stand is `support/effects-harness.ts`.
 */

beforeEach(openEffectsJournalDir)
afterEach(disposeEffectsJournalDir)

describe('executeEffect — run writing stdout to a file', () => {
  const LINES = '{"a":1}\n{"b":2}\n{"c":3}\n'

  test('the file holds what the command printed, at 0600, and the pane holds the receipt', async () => {
    const { cell } = await signedInCell()
    const path = join(journalDirOf(), 'export.jsonl')
    const dispatch = recordingDispatch((io) => {
      io.stdout.write('{"a":1}\n')
      io.stdout.write('{"b":2}\n')
      io.stdout.write('{"c":3}\n')
      io.stderr.write('legacy records not imported\n')
      return 0
    })

    const message = await executeEffect(
      { kind: 'run', request: exportRequest(path) },
      depsOf(dispatch.fn, cell),
    )

    expect(await readFile(path, 'utf8')).toBe(LINES)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const { result } = runResultOf(message)
    expect(result.stdout).toBe(savedToLine(path, Buffer.byteLength(LINES)))
    expect(result.stderr).toBe('legacy records not imported\n')
    expect(result.exitCode).toBe(0)
  })

  test('a path that is already taken is a failed run, and nothing is dispatched', async () => {
    const { cell } = await signedInCell()
    const path = join(journalDirOf(), 'taken.jsonl')
    await writeFile(path, 'do not truncate me', 'utf8')
    const dispatch = recordingDispatch()

    const message = await executeEffect(
      { kind: 'run', request: exportRequest(path) },
      depsOf(dispatch.fn, cell),
    )

    const { result } = runResultOf(message)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('EEXIST')
    expect(result.stdout).toBe('')
    expect(dispatch.calls).toHaveLength(0)
    expect(await readFile(path, 'utf8')).toBe('do not truncate me')
  })

  test('a directory that does not exist is a failed run, and nothing is dispatched', async () => {
    const { cell } = await signedInCell()
    const dispatch = recordingDispatch()

    const message = await executeEffect(
      { kind: 'run', request: exportRequest(join(journalDirOf(), 'nowhere', 'export.jsonl')) },
      depsOf(dispatch.fn, cell),
    )

    const { result } = runResultOf(message)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('ENOENT')
    expect(dispatch.calls).toHaveLength(0)
  })

  test('a command that throws still leaves the file closed with what it had written', async () => {
    const { cell } = await signedInCell()
    const path = join(journalDirOf(), 'partial.jsonl')
    const dispatch = recordingDispatch((io) => {
      io.stdout.write('{"a":1}\n')
      throw new Error('the journal is on fire')
    })

    const message = await executeEffect(
      { kind: 'run', request: exportRequest(path) },
      depsOf(dispatch.fn, cell),
    )

    const { result } = runResultOf(message)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('the journal is on fire')
    expect(await readFile(path, 'utf8')).toBe('{"a":1}\n')
    expect(result.stdout).toBe(savedToLine(path, 8))
  })
})

/**
 * The deadlock a file sink used to be able to reach (phase 4 review, H1). A
 * command parks on `once('drain')` the moment a write is refused; a stream
 * that has errored emits no `'drain'` ever again, so the run never answered,
 * `executeEffect` never resolved, and the console stayed `busy` and deaf.
 * What matters here is that the effect ANSWERS — with the failure, as a run
 * that went wrong, rather than not at all.
 */
describe('executeEffect — a write failure under a parked command', () => {
  /** A chunk past the 64 KiB high-water mark of a file stream, so `write` refuses it. */
  const PAST_HIGH_WATER_MARK = `${'x'.repeat(256 * 1024)}\n`

  /** Long enough for a real drain, short enough that a deadlock is not a five-second wait. */
  const SETTLE_TIMEOUT_MS = 2_000

  const WRITE_FAILURE = 'ENOSPC-like: no space left on device'

  function settled<T>(promise: Promise<T>, what: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`${what} never settled`)), SETTLE_TIMEOUT_MS).unref()
      }),
    ])
  }

  /** Opens the production way, and hands the test the stream it opened. */
  function capturingStream(captured: { stream?: WriteStream }): SinkStreamFactory {
    return (path: string) => {
      const stream = exclusiveStream(path)
      captured.stream = stream
      return stream
    }
  }

  test('the run answers with the failure instead of parking the console for ever', async () => {
    // Arrange
    const { cell } = await signedInCell()
    const path = join(journalDirOf(), 'export.jsonl')
    const captured: { stream?: WriteStream } = {}
    const dispatch = recordingDispatch(async (io) => {
      const stdout = io.stdout as SinkWritable
      if (stdout.write(PAST_HIGH_WATER_MARK) === false) {
        const parked = new Promise<void>((resolve) => {
          stdout.once?.('drain', resolve)
        })
        captured.stream?.destroy(new Error(WRITE_FAILURE))
        await parked
      }
      return 0
    })

    // Act
    const message = await settled(
      executeEffect(
        { kind: 'run', request: exportRequest(path) },
        { ...depsOf(dispatch.fn, cell), openStream: capturingStream(captured) },
      ),
      'the run',
    )

    // Assert
    const { result } = runResultOf(message)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(WRITE_FAILURE)
    // And the pane must not tell the operator the export is on disk.
    expect(result.stdout).toContain('before failing')
  })
})
