import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ulid } from 'ulid'
import { runWrap } from '../../src/proxy/wrap.js'
import { collectPersistedBytes } from '../support/persisted-bytes.js'
import {
  FAKE_SERVER_PATH,
  createClientHarness,
  readJournalRecords,
  requestLine,
  waitUntil,
} from './harness.js'

const STDERR_SETTLE_MS = 100

describe('runWrap', () => {
  let journalDir: string

  beforeEach(async () => {
    journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-wrap-test-'))
  })

  afterEach(async () => {
    await rm(journalDir, { recursive: true, force: true })
  })

  test('relays client messages to the child and responses back byte-identically, and returns the exit code', async () => {
    const sessionId = ulid()
    const harness = createClientHarness()

    const runPromise = runWrap('node', [FAKE_SERVER_PATH], {
      dir: journalDir,
      sessionId,
      stdin: harness.clientOutbox,
      stdout: harness.clientStdout,
      stderr: harness.clientStderr,
    })

    harness.clientOutbox.write(requestLine(1, 'initialize'))
    harness.clientOutbox.write(requestLine(2, 'tools/list'))

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
    const sessionId = ulid()
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
    harness.clientOutbox.write(requestLine(1, 'tools/list', { api_key: 'sekret123' }))

    await waitUntil(() => harness.receivedLineCount() >= 1)
    harness.clientOutbox.end()
    await runPromise

    // Sweep every byte the sink persisted: journal.db and its -wal sidecar,
    // since a committed record may still live only in the WAL until a
    // checkpoint runs.
    const { fileNames, renderings } = await collectPersistedBytes(journalDir)
    expect(fileNames).toContain('journal.db') // positive sentinel: the sweep reached the store
    for (const rendering of renderings) {
      expect(rendering).not.toContain('sekret123')
      expect(rendering).toContain('[REDACTED]')
    }

    const records = await readJournalRecords(journalDir, sessionId)
    const requestRecord = records.find(
      (record) => record.direction === 'client→server' && record.kind === 'request',
    )
    const responseRecord = records.find(
      (record) => record.direction === 'server→client' && record.kind === 'response',
    )

    expect(requestRecord).toBeDefined()
    expect(responseRecord).toBeDefined()
  })

  test('journals a stderr line from the wrapped server as a server-stderr record', async () => {
    const sessionId = ulid()
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
    await new Promise((resolve) => setTimeout(resolve, STDERR_SETTLE_MS))
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
        sessionId: ulid(),
        stdin: harness.clientOutbox,
        stdout: harness.clientStdout,
        stderr: harness.clientStderr,
      }),
    ).rejects.toThrow(/this-binary-should-not-exist-xyz-123/)
  })
})
