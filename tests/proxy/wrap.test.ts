import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runWrap } from '../../src/proxy/wrap.js'
import type { JournalRecord } from '../../src/journal/record.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FAKE_SERVER_PATH = join(__dirname, '../fixtures/fake-server.mjs')

const POLL_INTERVAL_MS = 10
const POLL_TIMEOUT_MS = 5000

/** Polls until `predicate` is true or the timeout elapses. */
async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitUntil: timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

/** Reads and parses every JSONL record written for a session. */
async function readJournalRecords(dir: string, sessionId: string): Promise<JournalRecord[]> {
  const content = await readFile(join(dir, `${sessionId}.jsonl`), 'utf8')
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalRecord)
}

interface ClientHarness {
  readonly clientOutbox: PassThrough
  readonly clientInboxChunks: Buffer[]
  readonly clientStdout: PassThrough
  readonly clientStderr: PassThrough
  /** Number of complete newline-terminated lines received so far on clientStdout. */
  receivedLineCount(): number
}

/** Builds the injected client-facing streams used to drive runWrap in tests. */
function createClientHarness(): ClientHarness {
  const clientOutbox = new PassThrough()
  const clientStdout = new PassThrough()
  const clientInboxChunks: Buffer[] = []
  clientStdout.on('data', (chunk: Buffer) => clientInboxChunks.push(chunk))
  const clientStderr = new PassThrough()
  clientStderr.resume()

  function receivedLineCount(): number {
    const text = Buffer.concat(clientInboxChunks).toString('utf8')
    return text.split('\n').filter((line) => line.length > 0).length
  }

  return { clientOutbox, clientInboxChunks, clientStdout, clientStderr, receivedLineCount }
}

describe('runWrap', () => {
  let journalDir: string

  beforeEach(async () => {
    journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-wrap-test-'))
  })

  afterEach(async () => {
    await rm(journalDir, { recursive: true, force: true })
  })

  test('relays client messages to the child and responses back byte-identically, and returns the exit code', async () => {
    const sessionId = 'test-session-relay'
    const harness = createClientHarness()

    const runPromise = runWrap('node', [FAKE_SERVER_PATH], {
      dir: journalDir,
      sessionId,
      stdin: harness.clientOutbox,
      stdout: harness.clientStdout,
      stderr: harness.clientStderr,
    })

    harness.clientOutbox.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
    harness.clientOutbox.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)

    await waitUntil(() => harness.receivedLineCount() >= 2)

    const responseLines = Buffer.concat(harness.clientInboxChunks)
      .toString('utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id: number })

    expect(responseLines.map((response) => response.id)).toEqual([1, 2])

    harness.clientOutbox.end()
    const exitCode = await runPromise

    expect(exitCode).toBe(0)
  })

  test('journals both directions with secrets redacted, never storing the raw secret value', async () => {
    const sessionId = 'test-session-redaction'
    const harness = createClientHarness()

    const runPromise = runWrap('node', [FAKE_SERVER_PATH], {
      dir: journalDir,
      sessionId,
      stdin: harness.clientOutbox,
      stdout: harness.clientStdout,
      stderr: harness.clientStderr,
    })

    // tools/list ignores params and returns a fixed canned result, so the
    // server→client response never echoes the secret back — this test is
    // about the client→server request record being redacted, not about
    // fake-server's own echo behavior for other methods.
    harness.clientOutbox.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { api_key: 'sekret123' },
      })}\n`,
    )

    await waitUntil(() => harness.receivedLineCount() >= 1)
    harness.clientOutbox.end()
    await runPromise

    const rawJournalContent = await readFile(join(journalDir, `${sessionId}.jsonl`), 'utf8')
    expect(rawJournalContent).not.toContain('sekret123')
    expect(rawJournalContent).toContain('[REDACTED]')

    const records = await readJournalRecords(journalDir, sessionId)
    const requestRecord = records.find((record) => record.direction === 'client→server' && record.kind === 'request')
    const responseRecord = records.find((record) => record.direction === 'server→client' && record.kind === 'response')

    expect(requestRecord).toBeDefined()
    expect(responseRecord).toBeDefined()
  })

  test('journals a stderr line from the wrapped server as a server-stderr record', async () => {
    const sessionId = 'test-session-stderr'
    const harness = createClientHarness()

    const runPromise = runWrap('node', [FAKE_SERVER_PATH], {
      dir: journalDir,
      sessionId,
      stdin: harness.clientOutbox,
      stdout: harness.clientStdout,
      stderr: harness.clientStderr,
    })

    // The fake server writes its startup diagnostic to stderr immediately;
    // give the stderr splice a moment to tap and journal it.
    await new Promise((resolve) => setTimeout(resolve, 100))
    harness.clientOutbox.end()
    await runPromise

    const records = await readJournalRecords(journalDir, sessionId)
    const stderrRecord = records.find((record) => record.direction === 'server-stderr')

    expect(stderrRecord).toBeDefined()
    expect(stderrRecord?.kind).toBe('stderr')
    expect(String(stderrRecord?.payload)).toContain('fake-server: starting')
  })

  test('rejects when the wrapped command cannot be spawned', async () => {
    const harness = createClientHarness()

    await expect(
      runWrap('this-binary-should-not-exist-xyz-123', [], {
        dir: journalDir,
        sessionId: 'test-session-spawn-error',
        stdin: harness.clientOutbox,
        stdout: harness.clientStdout,
        stderr: harness.clientStderr,
      }),
    ).rejects.toThrow(/this-binary-should-not-exist-xyz-123/)
  })
})
