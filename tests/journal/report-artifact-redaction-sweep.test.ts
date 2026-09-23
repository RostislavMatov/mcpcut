import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { runExportCommand } from '../../src/cli/export-cmd.js'
import { runKeygenCommand } from '../../src/cli/keygen-cmd.js'
import { runPruneCommand } from '../../src/cli/prune-cmd.js'
import { REDACTED_PLACEHOLDER } from '../../src/config.js'
import { journalDbPathFor, openJournalDbShared } from '../../src/journal/db.js'
import { buildPoolRecord } from '../../src/journal/pool-record.js'
import { latestPruneMarker } from '../../src/journal/prune.js'
import { createRecordBuilder } from '../../src/journal/record.js'
import {
  generateAndWriteSigningKeyPair,
  loadSigningPrivateKey,
  SIGNING_KEY_FILENAME,
} from '../../src/journal/signing.js'
import { createJournalSink } from '../../src/journal/sink.js'
import { classify } from '../../src/protocol/classify.js'

/**
 * M5 wave 5, review round: the sweep that covers the EXPORTED ARTIFACTS.
 *
 * `tests/journal/signing-key-redaction-sweep.test.ts` proves a private-key
 * PEM never reaches `journal.db`, and `tests/journal/redaction-sweep.test.ts`
 * proves it for a generic API key. Neither of them covers `report.json`,
 * `records.jsonl`, `summary.md`, `signature.json` or the command's own
 * stdout/stderr -- and those are the bytes that LEAVE THE HOST. The review
 * swept them by hand and found no leak, so this is a missing GUARANTEE
 * rather than a live bug: without it, a future change to the summary
 * renderer, to the manifest's field set or to an error message could start
 * copying journal content into an auditor's copy with nothing failing.
 *
 * Built in the established pattern of the two sibling sweeps: real key
 * material, the ACTUAL pipeline (classify -> buildRecord -> sink), then the
 * real command, then every byte that reached the deliverable.
 */

/**
 * The single base64 body line of a PEM block, with no embedded newline --
 * see the sibling sweep for why a multi-line PEM constant cannot be compared
 * against serialized bytes directly (a real `\n` becomes `\` + `n`, so the
 * comparison would pass even if the key WERE present).
 */
function pemBodyLine(pem: string): string {
  const line = pem.split('\n').find((candidate) => !candidate.includes('-----'))
  if (line === undefined || line.length === 0) {
    throw new Error(`test setup: could not extract a PEM body line from: ${pem}`)
  }
  return line
}

let journalDir: string
let outParent: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-report-sweep-journal-'))
  outParent = await mkdtemp(join(tmpdir(), 'mcpcut-report-sweep-out-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
  await rm(outParent, { recursive: true, force: true })
})

interface CapturedIo {
  readonly stdout: { write: (chunk: string) => void }
  readonly stderr: { write: (chunk: string) => void }
  text(): string
}

function capturingIo(): CapturedIo {
  const chunks: string[] = []
  return {
    stdout: { write: (chunk: string) => chunks.push(chunk) },
    stderr: { write: (chunk: string) => chunks.push(chunk) },
    text: () => chunks.join(''),
  }
}

describe('export --report: no secret reaches the artifacts that leave the host', () => {
  test('a private-key PEM and a bearer token in journaled traffic appear nowhere in the export', async () => {
    const foreignKeyDir = await mkdtemp(join(tmpdir(), 'mcpcut-report-sweep-keydir-'))
    try {
      // Key material an MCP server or agent could put into a tool call --
      // deliberately NOT this installation's own key, so the assertion is
      // about redaction rather than about one special-cased path.
      const foreign = await generateAndWriteSigningKeyPair(foreignKeyDir)
      const foreignPrivate = await loadSigningPrivateKey(foreignKeyDir)
      if (!foreignPrivate.present) throw new Error('test setup: key was just generated')
      const foreignPrivateBody = pemBodyLine(foreignPrivate.privateKeyPem)
      const foreignPublicBody = pemBodyLine(foreign.publicKeyPem)
      const bearerToken = 'sk-live-0123456789abcdef0123456789abcdef'

      const rawLine = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'restore_backup',
          arguments: {
            note: `here is the key file contents:\n${foreignPrivate.privateKeyPem}`,
            authorization: `Bearer ${bearerToken}`,
            // Not a secret, and travelling in the same payload: the guard
            // against an over-broad fix that blanks every PEM block.
            publicKeyForReference: foreign.publicKeyPem,
          },
        },
      })
      const record = createRecordBuilder('session-report-sweep').buildRecord(
        classify(rawLine),
        'client→server',
      )
      const sink = createJournalSink('session-report-sweep', { dir: journalDir })
      sink.write(record)
      await sink.close()

      // This installation's OWN signing key is loaded by the export in order
      // to sign the manifest, so it is in the exporting process's memory --
      // exactly the material that must not end up in the deliverable.
      const io = capturingIo()
      expect(await runKeygenCommand([], io, { journalDir })).toBe(0)
      const ownPrivate = await readFile(join(journalDir, SIGNING_KEY_FILENAME), 'utf8')
      const ownPrivateBody = pemBodyLine(ownPrivate)

      const outDir = join(outParent, 'report')
      expect(await runExportCommand(['--report', '--out', outDir], io, { journalDir })).toBe(0)

      const fileNames = (await readdir(outDir)).sort()
      // Positive sentinel first: the sweep actually looked at a real export.
      expect(fileNames).toEqual(
        ['records.jsonl', 'report.json', 'signature.json', 'summary.md'].sort(),
      )

      const artifacts = await Promise.all(
        fileNames.map(async (name) => [name, await readFile(join(outDir, name), 'utf8')] as const),
      )
      const swept: readonly (readonly [string, string])[] = [...artifacts, ['stdout+stderr', io.text()]]

      for (const [name, text] of swept) {
        expect(text, `${name} must not carry the foreign private key`).not.toContain(foreignPrivateBody)
        expect(text, `${name} must not carry this installation's own private key`).not.toContain(
          ownPrivateBody,
        )
        expect(text, `${name} must not carry a private-key PEM header`).not.toContain(
          '-----BEGIN PRIVATE KEY-----',
        )
        expect(text, `${name} must not carry a bearer token`).not.toContain(bearerToken)
      }

      // The journal held the redacted form, and the export re-read it
      // verbatim: the placeholder proves the records really did travel.
      const recordsJsonl = artifacts.find(([name]) => name === 'records.jsonl')?.[1] ?? ''
      expect(recordsJsonl).toContain(REDACTED_PLACEHOLDER)
      // The public key, by contrast, is not a secret and must survive: an
      // over-broad fix that blanked every PEM block would break the very
      // material an auditor is handed.
      expect(recordsJsonl).toContain(foreignPublicBody)
    } finally {
      await rm(foreignKeyDir, { recursive: true, force: true })
    }
  })
})

describe('export --report: a secret in a pool record reaches no artifact (ADR-0015 phase 5)', () => {
  test('a vault value an upstream echoed into a refusal reason appears nowhere in the export', async () => {
    // The pool section of summary.md renders `reason` from the journal. The
    // guarantee is that the value never got INTO the journal -- the pool
    // builder matches server-influenced fields against the pool's known
    // secrets -- and that nothing on the way out re-derives it.
    const vaultValue = 'vault-value-7f3a9c2e5b1d4f60'
    const sink = createJournalSink('pool-sweep', { dir: journalDir })
    sink.write(
      buildPoolRecord({
        sessionId: 'pool-sweep',
        knownSecrets: [vaultValue],
        pool: {
          agentName: 'bot',
          event: 'attach-refused',
          serverName: 'files',
          reason: `upstream said: token ${vaultValue} rejected`,
        },
      }),
    )
    await sink.close()
    const io = capturingIo()
    expect(await runKeygenCommand([], io, { journalDir })).toBe(0)

    const outDir = join(outParent, 'report')
    expect(await runExportCommand(['--report', '--out', outDir], io, { journalDir })).toBe(0)

    const fileNames = (await readdir(outDir)).sort()
    const artifacts = await Promise.all(
      fileNames.map(async (name) => [name, await readFile(join(outDir, name), 'utf8')] as const),
    )
    // Positive sentinel: the pool section really rendered this record.
    const summary = artifacts.find(([name]) => name === 'summary.md')?.[1] ?? ''
    expect(summary).toContain('- Did not attach: files (upstream said: token')
    for (const [name, text] of [...artifacts, ['stdout+stderr', io.text()] as const]) {
      expect(text, `${name} must not carry the vault value`).not.toContain(vaultValue)
    }
  })
})

describe('prune: no secret reaches the retention marker or the command output', () => {
  test('the marker row and both prune reports carry fingerprints and signatures, never key material', async () => {
    // Retention is the other surface that touches the signing key (the marker
    // is signed with it) and the other one an operator copies into a ticket.
    // Swept for the same guarantee as the export artifacts, for the same
    // reason: no leak exists today, and nothing would fail if a future change
    // started printing the key or the pruned records' contents.
    const bearerToken = 'sk-live-fedcba9876543210fedcba9876543210'
    const rawLine = JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'sync', arguments: { authorization: `Bearer ${bearerToken}` } },
    })
    const record = createRecordBuilder('session-prune-sweep').buildRecord(classify(rawLine), 'client→server')
    const sink = createJournalSink('session-prune-sweep', { dir: journalDir })
    sink.write(record)
    await sink.close()

    const io = capturingIo()
    expect(await runKeygenCommand([], io, { journalDir })).toBe(0)
    const ownPrivateBody = pemBodyLine(await readFile(join(journalDir, SIGNING_KEY_FILENAME), 'utf8'))

    // A cutoff far in the future makes every record eligible, so the prune
    // really runs (and really signs a marker) rather than reporting nothing.
    const clock = () => Date.parse('2126-01-01T00:00:00.000Z')
    expect(await runPruneCommand(['--older-than', '30d'], io, { journalDir, clock })).toBe(0)
    // The deleting half needs an owner token since owner decision Q17; the
    // sweep below covers the record it now writes as well as the marker.
    const { token } = await createAdminStore({ journalDir }).createAdmin('alice', 'owner')
    const env = { [ADMIN_TOKEN_ENV_VAR]: token }
    expect(
      await runPruneCommand(['--older-than', '30d', '--yes'], io, { journalDir, clock, env }),
    ).toBe(0)

    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    const marker = latestPruneMarker(handle)
    // Positive sentinel: the sweep looked at a real, signed marker.
    expect(marker?.signature?.signatureBase64).toEqual(expect.any(String))

    const swept: readonly (readonly [string, string])[] = [
      ['prune stdout+stderr', io.text()],
      ['prune marker row', JSON.stringify(marker)],
    ]
    for (const [name, text] of swept) {
      expect(text, `${name} must not carry this installation's private key`).not.toContain(ownPrivateBody)
      expect(text, `${name} must not carry a private-key PEM header`).not.toContain('-----BEGIN PRIVATE KEY-----')
      expect(text, `${name} must not carry a bearer token from the pruned records`).not.toContain(bearerToken)
    }
  })
})
