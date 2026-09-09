import type { WriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { JOURNAL_FILE_MODE } from '../../src/config.js'
import { savedPartiallyLine, savedToLine } from '../../src/tui/constants.js'
import { exclusiveStream, fileSink, memorySink } from '../../src/tui/run-sink.js'

/**
 * Where a run's output goes (mcpcut phase 4, task 8).
 *
 * Two sinks with one interface: the memory sink the output pane draws from,
 * and the file sink an `export` writes through. The file sink carries the
 * properties this test exists for — the file is created exclusively (`wx`),
 * so an existing path or a planted symlink is refused instead of truncated;
 * it is created at 0600, like every other file the plane writes; and a write
 * failure that arrives AFTER the file opened (ENOSPC) is kept and surfaced by
 * `finish()` rather than escaping as an `uncaughtException` that would take
 * the console down with it.
 */

const LIMIT = 1024

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-run-sink-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// memorySink
// ---------------------------------------------------------------------------

describe('memorySink', () => {
  test('keeps both streams exactly as the command wrote them', () => {
    const sink = memorySink(LIMIT)

    sink.io.stdout.write('alice  owner\n')
    sink.io.stderr.write('a warning\n')

    expect(sink.out()).toBe('alice  owner\n')
    expect(sink.err()).toBe('a warning\n')
    expect(sink.truncated()).toBe(false)
  })

  test('reports a write past the limit as truncated', () => {
    const sink = memorySink(4)

    sink.io.stdout.write('12345')

    expect(sink.out()).toBe('')
    expect(sink.truncated()).toBe(true)
  })

  test('finishing closes nothing and resolves', async () => {
    const sink = memorySink(LIMIT)

    await expect(sink.finish()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// fileSink — the happy path
// ---------------------------------------------------------------------------

describe('fileSink', () => {
  test('writes stdout to the file byte for byte, at 0600', async () => {
    const path = join(dir, 'export.jsonl')
    const sink = await fileSink(path, LIMIT)

    sink.io.stdout.write('{"a":1}\n')
    sink.io.stdout.write('{"b":2}\n')
    await sink.finish()

    expect(await readFile(path, 'utf8')).toBe('{"a":1}\n{"b":2}\n')
    expect((await stat(path)).mode & 0o777).toBe(JOURNAL_FILE_MODE)
  })

  test('its stdout reads back as the receipt, not as the text that went to disk', async () => {
    const path = join(dir, 'export.jsonl')
    const sink = await fileSink(path, LIMIT)

    sink.io.stdout.write('{"a":1}\n')
    await sink.finish()

    expect(sink.out()).toBe(savedToLine(path, 8))
  })

  test('stderr is captured in memory, and its limit still applies', async () => {
    const path = join(dir, 'export.jsonl')
    const sink = await fileSink(path, 4)

    sink.io.stderr.write('legacy records not imported\n')
    await sink.finish()

    expect(sink.err()).toBe('')
    expect(sink.truncated()).toBe(true)
  })

  test('forwards a drain listener to the file stream', async () => {
    const path = join(dir, 'big.jsonl')
    const sink = await fileSink(path, LIMIT)
    const chunk = `${'x'.repeat(256 * 1024)}\n`

    const accepted = sink.io.stdout.write(chunk)
    const drained = new Promise<void>((resolve) => {
      sink.io.stdout.once?.('drain', resolve)
    })
    await drained
    await sink.finish()

    expect(accepted).toBe(false)
    expect((await stat(path)).size).toBe(chunk.length)
  })
})

// ---------------------------------------------------------------------------
// fileSink — refusals before the file exists
// ---------------------------------------------------------------------------

describe('fileSink refuses to open', () => {
  test('a path that already holds a file', async () => {
    const path = join(dir, 'taken.jsonl')
    await writeFile(path, 'do not truncate me', 'utf8')

    await expect(fileSink(path, LIMIT)).rejects.toThrow(/EEXIST/)
    expect(await readFile(path, 'utf8')).toBe('do not truncate me')
  })

  test('a symbolic link, so a planted link cannot redirect the export', async () => {
    const target = join(dir, 'secret.txt')
    await writeFile(target, 'the operator’s own file', 'utf8')
    const path = join(dir, 'link.jsonl')
    await symlink(target, path)

    await expect(fileSink(path, LIMIT)).rejects.toThrow(/EEXIST/)
    expect(await readFile(target, 'utf8')).toBe('the operator’s own file')
  })

  test('a path whose directory does not exist', async () => {
    const path = join(dir, 'nowhere', 'export.jsonl')

    await expect(fileSink(path, LIMIT)).rejects.toThrow(/ENOENT/)
  })
})

// ---------------------------------------------------------------------------
// fileSink — a failure that arrives after the file opened
// ---------------------------------------------------------------------------

describe('fileSink after open', () => {
  /** Opens the production way, and hands the test the stream it opened. */
  function capturingStream(captured: { stream?: WriteStream }): (path: string) => WriteStream {
    return (path: string) => {
      const stream = exclusiveStream(path)
      captured.stream = stream
      return stream
    }
  }

  test('a write failure is kept and thrown by finish, never emitted at the process', async () => {
    const path = join(dir, 'export.jsonl')
    const captured: { stream?: WriteStream } = {}
    const sink = await fileSink(path, LIMIT, capturingStream(captured))
    sink.io.stdout.write('{"a":1}\n')

    captured.stream?.destroy(new Error('ENOSPC-like: no space left on device'))

    await expect(sink.finish()).rejects.toThrow('ENOSPC-like: no space left on device')
  })
})

// ---------------------------------------------------------------------------
// fileSink — a writer parked on backpressure when the failure arrives
// ---------------------------------------------------------------------------

/**
 * The deadlock this section exists for (phase 4 review, H1). `export-cmd.ts`
 * awaits `once('drain')` whenever a write is refused; Node emits no `'drain'`
 * on a stream that has errored, and every later `write` keeps answering
 * `false`. A sink that forwarded only `'drain'` therefore parked the command
 * for ever — and with it the effect, the `Msg`, and a console left `busy`.
 */
describe('fileSink when the stream fails under a parked writer', () => {
  /** A chunk past the 64 KiB high-water mark of a file stream, so `write` refuses it. */
  const PAST_HIGH_WATER_MARK = `${'x'.repeat(256 * 1024)}\n`

  /** Long enough for a real drain, short enough that a deadlock is not a five-second wait. */
  const SETTLE_TIMEOUT_MS = 2_000

  /** Rejects rather than hanging, so a regression reads as a deadlock instead of a timeout. */
  function settled<T>(promise: Promise<T>, what: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`${what} never settled`)), SETTLE_TIMEOUT_MS).unref()
      }),
    ])
  }

  function capturingStream(captured: { stream?: WriteStream }): (path: string) => WriteStream {
    return (path: string) => {
      const stream = exclusiveStream(path)
      captured.stream = stream
      return stream
    }
  }

  test('releases a drain listener registered before the failure', async () => {
    // Arrange
    const captured: { stream?: WriteStream } = {}
    const sink = await fileSink(join(dir, 'export.jsonl'), LIMIT, capturingStream(captured))

    // Act: exactly the order `writeDocs` uses — refused write, then park.
    const accepted = sink.io.stdout.write(PAST_HIGH_WATER_MARK)
    const parked = new Promise<void>((resolve) => {
      sink.io.stdout.once?.('drain', resolve)
    })
    captured.stream?.destroy(new Error('ENOSPC-like: no space left on device'))

    // Assert
    expect(accepted).toBe(false)
    await expect(settled(parked, 'the parked writer')).resolves.toBeUndefined()
  })

  test('releases a drain listener registered after the failure', async () => {
    const captured: { stream?: WriteStream } = {}
    const sink = await fileSink(join(dir, 'export.jsonl'), LIMIT, capturingStream(captured))
    sink.io.stdout.write(PAST_HIGH_WATER_MARK)

    captured.stream?.destroy(new Error('ENOSPC-like: no space left on device'))
    const parked = new Promise<void>((resolve) => {
      sink.io.stdout.once?.('drain', resolve)
    })

    await expect(settled(parked, 'the late writer')).resolves.toBeUndefined()
  })

  test('accepts and drops what is written after the failure, so no writer parks again', async () => {
    const captured: { stream?: WriteStream } = {}
    const sink = await fileSink(join(dir, 'export.jsonl'), LIMIT, capturingStream(captured))
    captured.stream?.destroy(new Error('ENOSPC-like: no space left on device'))

    expect(sink.io.stdout.write('{"a":1}\n')).toBe(true)
    await expect(sink.finish()).rejects.toThrow('ENOSPC-like')
  })

  test('the receipt says the file was left incomplete, not that it was written', async () => {
    const path = join(dir, 'export.jsonl')
    const captured: { stream?: WriteStream } = {}
    const sink = await fileSink(path, LIMIT, capturingStream(captured))
    captured.stream?.destroy(new Error('ENOSPC-like: no space left on device'))

    await expect(sink.finish()).rejects.toThrow('ENOSPC-like')
    expect(sink.out()).toBe(savedPartiallyLine(path, 0))
    expect(sink.out()).not.toBe(savedToLine(path, 0))
  })
})
