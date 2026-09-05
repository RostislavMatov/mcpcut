import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { LOG_TAIL_DEFAULT_LINES, LOG_TAIL_MAX_BYTES } from '../../src/services/constants.js'
import { readLogTail } from '../../src/services/log-tail.js'

/**
 * `mcpcut logs` reads the end of a daemon log (mcpcut phase 1, Task 9).
 *
 * The interesting property is what it must NOT do: a service log nobody
 * rotates can outgrow memory, so the tail reads a bounded window from the end
 * of the file rather than the file. That window almost always starts inside a
 * line, and half a line printed as if it were a whole one is a lie about what
 * the service logged — so the partial head of the window is dropped.
 */

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-journal-log-tail-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Writes `content` to a file in the temp dir and returns its path. */
async function writeLog(name: string, content: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, content, 'utf8')
  return path
}

describe('readLogTail: nothing to show', () => {
  test('returns no lines when the service has never been started (no log file)', async () => {
    expect(await readLogTail(join(dir, 'ui.log'))).toEqual([])
  })

  test('returns no lines when the log exists but is empty', async () => {
    const path = await writeLog('ui.log', '')

    expect(await readLogTail(path)).toEqual([])
  })

  test('returns no lines when asked for none, rather than the whole file', async () => {
    const path = await writeLog('ui.log', 'a\nb\nc\n')

    expect(await readLogTail(path, 0)).toEqual([])
  })
})

describe('readLogTail: a log that fits in the window', () => {
  test('returns every line in order when the log has exactly the requested count', async () => {
    const lines = ['ui: listening on http://127.0.0.1:8091', 'ui: SIGTERM received', 'ui: bye']
    const path = await writeLog('ui.log', `${lines.join('\n')}\n`)

    expect(await readLogTail(path, lines.length)).toEqual(lines)
  })

  test('returns only the last N lines when the log is longer', async () => {
    const path = await writeLog('ui.log', `${['one', 'two', 'three', 'four'].join('\n')}\n`)

    expect(await readLogTail(path, 2)).toEqual(['three', 'four'])
  })

  test('keeps a final line that the service never terminated with a newline', async () => {
    const path = await writeLog('serve.log', 'serve: starting\nserve: crashed mid-line')

    expect(await readLogTail(path, 2)).toEqual(['serve: starting', 'serve: crashed mid-line'])
  })

  test('drops the trailing empty line a newline-terminated log would otherwise produce', async () => {
    const path = await writeLog('serve.log', 'only\n')

    expect(await readLogTail(path, 5)).toEqual(['only'])
  })

  test('preserves blank lines inside the tail', async () => {
    const path = await writeLog('ui.log', 'a\n\nb\n')

    expect(await readLogTail(path, 5)).toEqual(['a', '', 'b'])
  })

  test('defaults to the manager-wide tail length', async () => {
    const written = Array.from({ length: LOG_TAIL_DEFAULT_LINES + 10 }, (_, index) => `line ${index}`)
    const path = await writeLog('ui.log', `${written.join('\n')}\n`)

    const tail = await readLogTail(path)

    expect(tail).toHaveLength(LOG_TAIL_DEFAULT_LINES)
    expect(tail.at(-1)).toBe(`line ${written.length - 1}`)
  })
})

describe('readLogTail: a log larger than the read window', () => {
  test('returns only whole trailing lines and never a half line from the window edge', async () => {
    // Each line is long enough that the 64 KiB window lands mid-line.
    const filler = 'x'.repeat(200)
    const written = Array.from(
      { length: Math.ceil((LOG_TAIL_MAX_BYTES * 2) / 201) },
      (_, index) => `${index}-${filler}`,
    )
    const path = await writeLog('ui.log', `${written.join('\n')}\n`)

    const tail = await readLogTail(path, 5)

    expect(tail).toEqual(written.slice(-5))
    // Nothing truncated: every returned line is one the writer actually wrote.
    for (const line of tail) expect(written).toContain(line)
  })

  test('returns at most the lines that fit in the window, never more', async () => {
    const filler = 'y'.repeat(999)
    const written = Array.from({ length: 200 }, (_, index) => `${index}-${filler}`)
    const path = await writeLog('serve.log', `${written.join('\n')}\n`)

    // 200 KiB of log, a 64 KiB window: fewer than 100 whole lines can be seen.
    const tail = await readLogTail(path, 200)

    expect(tail.length).toBeLessThan(written.length)
    expect(tail.at(-1)).toBe(written.at(-1))
    expect(written).toContain(tail[0])
  })
})
