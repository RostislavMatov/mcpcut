import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { JournalRecord } from '../../src/journal/record.js'

/**
 * Shared test harness for the proxy lifecycle tests: fixture paths, polling,
 * journal reading, and the injected client-facing streams used to drive
 * runWrap without touching the real process stdio.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))

export const FAKE_SERVER_PATH = join(__dirname, '../fixtures/fake-server.mjs')
export const BURST_SERVER_PATH = join(__dirname, '../fixtures/burst-server.mjs')
export const DYING_SERVER_PATH = join(__dirname, '../fixtures/dying-server.mjs')

const POLL_INTERVAL_MS = 10
const POLL_TIMEOUT_MS = 5000

/** Polls until `predicate` is true or the timeout elapses. */
export async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitUntil: timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

/** Reads and parses every JSONL record written for a session. */
export async function readJournalRecords(dir: string, sessionId: string): Promise<JournalRecord[]> {
  const content = await readFile(join(dir, `${sessionId}.jsonl`), 'utf8')
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalRecord)
}

export interface ClientHarness {
  readonly clientOutbox: PassThrough
  readonly clientInboxChunks: Buffer[]
  readonly clientStdout: PassThrough
  readonly clientStderr: PassThrough
  /** Number of complete newline-terminated lines received so far on clientStdout. */
  receivedLineCount(): number
}

/** Builds the injected client-facing streams used to drive runWrap in tests. */
export function createClientHarness(): ClientHarness {
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

export interface SlowWritable {
  readonly writable: Writable
  readonly chunks: Buffer[]
  /** Number of complete newline-terminated lines acknowledged so far. */
  receivedLineCount(): number
}

/**
 * A destination that acknowledges each write only after `delayMs`, modelling a
 * client that reads slowly. A chunk counts as "received" only once the slow
 * consumer has actually taken it, which is what the drain guarantee is about.
 */
export function createSlowWritable(delayMs: number, highWaterMark = 1): SlowWritable {
  const chunks: Buffer[] = []
  const writable = new Writable({
    highWaterMark,
    write(chunk: Buffer, _encoding, callback) {
      setTimeout(() => {
        chunks.push(chunk)
        callback()
      }, delayMs)
    },
  })

  function receivedLineCount(): number {
    return Buffer.concat(chunks)
      .toString('utf8')
      .split('\n')
      .filter((line) => line.length > 0).length
  }

  return { writable, chunks, receivedLineCount }
}

/** Builds one newline-terminated JSON-RPC request line. */
export function requestLine(id: number, method: string, params: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
}
