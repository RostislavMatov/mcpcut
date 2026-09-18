import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { REDACTED_PLACEHOLDER } from '../../src/config.js'
import { generateAndWriteSigningKeyPair, loadSigningPrivateKey } from '../../src/journal/signing.js'
import { createJournalSink } from '../../src/journal/sink.js'
import { createRecordBuilder } from '../../src/journal/record.js'
import { classify } from '../../src/protocol/classify.js'
import { collectPersistedBytes } from '../support/persisted-bytes.js'

/**
 * M5 wave 4, task 4.4: the private-key half of the "never reaches the
 * journal" guarantee, built the same way `tests/journal/redaction-sweep.test.ts`
 * proves it for a generic API key -- a real installation key from
 * `journal/signing.ts`, sent through the ACTUAL pipeline
 * (`classify()` -> `createRecordBuilder().buildRecord()` ->
 * `createJournalSink().write()`/`flush()`), never lands on disk.
 *
 * This is defence in depth, not the primary guarantee: `tests/architecture/
 * imports.test.ts` already proves nothing outside `signing.ts` can even
 * import the signing primitives, and `signing.ts` itself never hands the
 * private key to anything MCP-traffic-shaped. But an agent or a malicious/
 * misbehaving MCP server is free to put ANY string in a tool call's
 * arguments or a tool result -- including, if it somehow obtained this
 * host's own signing key file, its exact PEM text -- and the redaction layer
 * is what stands between that string and `journal.db`, exactly the same way
 * it is the only thing standing between a stolen Bearer token and the
 * journal (see the sibling sweep test).
 */

/**
 * The single base64 body line of a PEM block, with no embedded newline.
 * Needed because the journal stores the payload as JSON TEXT: a real `\n`
 * inside a string value is re-escaped to the two characters `\` + `n` on
 * every serialization, so comparing a multi-line PEM constant (real
 * newlines) against the JSON-serialized bytes on disk (escaped newlines)
 * would never match either way -- a `not.toContain` check built on that
 * mismatch would pass even if the key text WAS present. The base64 body
 * itself has no newline, so it round-trips identically through JSON escaping
 * and is a real assertion either way.
 */
function pemBodyLine(pem: string): string {
  const line = pem.split('\n').find((candidate) => !candidate.includes('-----'))
  if (line === undefined || line.length === 0) {
    throw new Error(`test setup: could not extract a PEM body line from: ${pem}`)
  }
  return line
}

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-signing-key-sweep-test-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

describe('journal redaction sweep: the signing private key never reaches journal.db', () => {
  test('a real Ed25519 private key PEM embedded in tool-call arguments is redacted before persistence', async () => {
    // A separate, dedicated key-directory: this is deliberately NOT the
    // installation's own signing key location `journalDir` writes to below --
    // the point is that this REAL key material, however it got there, must
    // never survive the pipeline, not that this specific installation's key
    // is somehow special-cased.
    const keyDir = await mkdtemp(join(tmpdir(), 'mcpcut-signing-key-sweep-keydir-'))
    try {
      const generated = await generateAndWriteSigningKeyPair(keyDir)
      const privateKey = await loadSigningPrivateKey(keyDir)
      if (!privateKey.present) throw new Error('test setup: key was just generated')
      const keyBody = privateKey.privateKeyPem
      const privateKeyBodyLine = pemBodyLine(keyBody)
      const publicKeyBodyLine = pemBodyLine(generated.publicKeyPem)

      const rawLine = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'restore_backup',
          arguments: {
            note: `here is the key file contents:\n${keyBody}`,
            // The public key travelling alongside it in the SAME payload is
            // the over-redaction guard below: a fix broad enough to blank
            // every PEM block indiscriminately would also destroy this,
            // which is not a secret and must survive untouched.
            publicKeyForReference: generated.publicKeyPem,
          },
        },
      })

      const record = createRecordBuilder('session-signing-key-sweep').buildRecord(
        classify(rawLine),
        'client→server',
      )

      // Sanity: the record itself is already clean before it ever reaches storage.
      expect(JSON.stringify(record)).not.toContain(privateKeyBodyLine)
      expect(JSON.stringify(record)).not.toContain('-----BEGIN PRIVATE KEY-----')
      expect(JSON.stringify(record)).toContain(REDACTED_PLACEHOLDER)

      const sink = createJournalSink('session-signing-key-sweep', { dir: journalDir })
      sink.write(record)
      await sink.flush()

      const { fileNames, renderings } = await collectPersistedBytes(journalDir)
      // Positive sentinel first: the sweep actually reached the store.
      expect(fileNames).toContain('journal.db')
      if (fileNames.some((name) => name.endsWith('-wal'))) {
        expect(fileNames).toContain('journal.db-wal')
      }

      for (const rendering of renderings) {
        expect(rendering).not.toContain(privateKeyBodyLine)
        expect(rendering).not.toContain('-----BEGIN PRIVATE KEY-----')
      }
      expect(renderings.some((rendering) => rendering.includes(REDACTED_PLACEHOLDER))).toBe(true)

      // The public key, by contrast, is NOT a secret -- it is meant to be
      // handed to an auditor. It travelled in the SAME payload as the private
      // key above; confirming it survives guards against an over-broad fix
      // that would blank every "-----BEGIN ... KEY-----" block indiscriminately.
      expect(renderings.some((rendering) => rendering.includes(publicKeyBodyLine))).toBe(true)
    } finally {
      await rm(keyDir, { recursive: true, force: true })
    }
  })
})
