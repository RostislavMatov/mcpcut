import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

/**
 * The commit path's timers must be REF'd (M4.5 wave 4 review, HIGH). Node
 * exits the instant the only pending work is an unref'd timer, and an `await`
 * on a promise that such a timer would settle simply never resumes — so an
 * unref'd retry delay lets a `connect`/`wrap` process exit 0 in the middle of
 * `flush()`, dropping records the durability contract already counts as
 * confirmed. Only the passive batch-accumulation timer may be unref'd, and
 * nothing awaits that one.
 *
 * In-process this is untestable: the defect IS process exit. So, mirroring
 * `durability.test.ts`, a child (`fixtures/retry-timer-child.mjs`, run against
 * the built `dist/`) is arranged so the retry delay is the only thing left
 * holding the loop open, and we check it lived long enough to settle.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = join(__dirname, 'fixtures/retry-timer-child.mjs')
const TEST_TIMEOUT_MS = 20_000

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-retry-timer-test-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

interface ChildResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

function runChild(dbPath: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE_PATH, dbPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('the retry delay keeps the process alive until the record settles', () => {
  test(
    'a child with nothing but a pending retry commits the record before exiting',
    async () => {
      const result = await runChild(join(journalDir, 'journal.db'))

      // Node's `node:sqlite` ExperimentalWarning reaches stderr through the
      // import chain and is not a failure; anything else there is.
      expect(result.stderr.replace(/^\((?:node:\d+\)|Use `node) .*\n?/gm, '').trim()).toBe('')
      expect(result.code).toBe(0)
      // Both lines, in order: the second one exists only if the process was
      // still alive when the retry delay elapsed.
      expect(result.stdout.split('\n').filter((line) => line !== '')).toEqual([
        'enqueued',
        'settled:ok',
      ])
    },
    TEST_TIMEOUT_MS,
  )
})
