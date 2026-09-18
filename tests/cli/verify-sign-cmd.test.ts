import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runKeygenCommand } from '../../src/cli/keygen-cmd.js'
import { runVerifyCommand } from '../../src/cli/verify-cmd.js'
import { journalDbPathFor, openJournalDbShared } from '../../src/journal/db.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createJournalSink } from '../../src/journal/sink.js'
import { loadSigningPrivateKey, verifyChainHeadAnchorSignature } from '../../src/journal/signing.js'

/**
 * `mcpcut verify --sign` (M5 wave 4, task 4.3): signs the current chain
 * HEAD, not every record. Companion to `tests/cli/verify-cmd.test.ts` (the
 * unsigned walk) and `tests/journal/signing.test.ts` (the crypto primitives
 * in isolation).
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-verify-sign-cmd-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function fakeIo(): {
  stdout: { write: (chunk: string) => void }
  stderr: { write: (chunk: string) => void }
  out: () => string
  err: () => string
} {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

function run(args: string[], io = fakeIo()): Promise<number> {
  return runVerifyCommand(args, io, { journalDir })
}

async function keygen(): Promise<void> {
  const exitCode = await runKeygenCommand([], fakeIo(), { journalDir })
  if (exitCode !== 0) throw new Error('test setup: keygen failed')
}

function recordOf(sessionId: string, id: string, method: string): JournalRecord {
  return {
    id,
    ts: new Date().toISOString(),
    sessionId,
    direction: 'client→server',
    kind: 'request',
    method,
    payload: {},
  }
}

async function writeRecordsViaSink(sessionId: string, records: readonly JournalRecord[]): Promise<void> {
  const sink = createJournalSink(sessionId, { dir: journalDir })
  for (const record of records) {
    sink.write(record)
  }
  await sink.close()
}

describe('verify --sign: no signing key present', () => {
  test('fails clearly, exit non-zero, emits no signature-shaped output', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])
    const io = fakeIo()

    const exitCode = await run(['--sign'], io)

    expect(exitCode).not.toBe(0)
    expect(io.err()).toMatch(/no signing key|keygen/i)
    expect(io.out()).not.toMatch(/signature/i)
  })

  // Regression: "no signing key yet" is an ordinary state on a fresh install
  // before `keygen` has run -- it must never downgrade a REAL break's exit
  // code. Before this fix, attemptSignChainHead's failure short-circuited to
  // exit 1 unconditionally, so a genuinely broken chain reported on stdout
  // (BROKEN at seq ...) still exited 1 on such a host, and an auditor's
  // script watching only the exit code never escalated.
  test('a broken chain still exits 2 when --sign additionally fails for lack of a key -- the break is not masked', async () => {
    await writeRecordsViaSink('session-a', [
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA1', 'tools/call'),
    ])
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    handle.db.prepare('UPDATE journal_records SET doc = ? WHERE seq = 2').run('{"tampered":true}')
    const io = fakeIo()

    const exitCode = await run(['--sign'], io)

    expect(exitCode).toBe(2)
    expect(io.out()).toMatch(/BROKEN at seq 2/)
    // The sign failure is still reported -- exit code escalation must not
    // come at the cost of hiding WHY signing itself could not happen.
    expect(io.err()).toMatch(/no signing key|keygen/i)
  })
})

describe('verify --sign: empty journal', () => {
  test('nothing to sign -- fails clearly rather than signing a head that does not exist', async () => {
    await openJournalDbShared(journalDbPathFor(journalDir))
    await keygen()
    const io = fakeIo()

    const exitCode = await run(['--sign'], io)

    expect(exitCode).not.toBe(0)
    expect(io.err()).toMatch(/nothing to sign/i)
    expect(io.out()).not.toMatch(/signature/i)
    // A key exists on disk (keygen() above) even though this refusal never
    // reaches signChainHeadAnchor -- an error path is exactly where a secret
    // usually escapes (task 4.4 brief), so this is checked here too, not
    // only on the success path.
    const privateKey = await loadSigningPrivateKey(journalDir)
    if (privateKey.present) {
      expect(io.out()).not.toContain(privateKey.privateKeyPem)
      expect(io.err()).not.toContain(privateKey.privateKeyPem)
    }
  })
})

describe('verify --sign: journal exists but predates the hash chain', () => {
  test('does not sign an unattested record as though it were attested', async () => {
    const sink = createJournalSink('legacy-session', { dir: journalDir })
    sink.write(recordOf('legacy-session', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping'))
    await sink.close()
    // The sink above already runs through the (chained) batch writer, so to
    // get a genuinely pre-chain row we insert directly, mirroring
    // `chain-verify.test.ts`'s `insertLegacyRow`.
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    handle.db.prepare('DELETE FROM journal_records').run()
    handle.db
      .prepare(
        'INSERT INTO journal_records (session_id, record_id, ts, direction, kind, method, doc) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('legacy-session', 'legacy-1', new Date().toISOString(), 'client→server', 'request', 'ping', '{}')
    await keygen()
    const io = fakeIo()

    const exitCode = await run(['--sign'], io)

    expect(exitCode).not.toBe(0)
    expect(io.err()).toMatch(/nothing to sign/i)
    // Same rationale as the empty-journal case above: a key exists (keygen()
    // just above) but this refusal happens before signing -- check anyway.
    const privateKey = await loadSigningPrivateKey(journalDir)
    if (privateKey.present) {
      expect(io.out()).not.toContain(privateKey.privateKeyPem)
      expect(io.err()).not.toContain(privateKey.privateKeyPem)
    }
  })
})

describe('verify --sign: clean chain with a key present', () => {
  test('exit 0, emits a verifiable anchor and the same-uid caveat', async () => {
    await writeRecordsViaSink('session-a', [
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA1', 'tools/call'),
    ])
    await keygen()
    const io = fakeIo()

    const exitCode = await run(['--sign'], io)

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out).toMatch(/seq[: ]+2/)
    expect(out).toMatch(/signature/i)
    // The honest threat-model caveat must be in the command's OWN output,
    // not just docs -- see the task brief.
    expect(out).toMatch(/same (?:user|uid)/i)
    expect(out).toMatch(/out-of-band|outside this host|elsewhere/i)
    // Banned terminology stays banned project-wide until a later wave.
    expect(out).not.toMatch(/tamper-evident/i)
    expect(out).not.toMatch(/audit-ready/i)
  })

  test('the emitted anchor is independently verifiable with the public key on disk', async () => {
    await writeRecordsViaSink('session-a', [
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list'),
    ])
    await keygen()

    // Sign via the CLI, then re-derive the exact same statement out of band
    // (as an auditor would) and check it against the public key file --
    // this is the round trip the CLI's own crypto must support.
    const privateKey = await loadSigningPrivateKey(journalDir)
    if (!privateKey.present) throw new Error('test setup: key missing')
    const io = fakeIo()
    const exitCode = await run(['--sign'], io)
    expect(exitCode).toBe(0)

    const { signChainHeadAnchor } = await import('../../src/journal/signing.js')
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    const row = handle.db
      .prepare('SELECT seq, record_hash AS recordHash FROM journal_records ORDER BY seq DESC LIMIT 1')
      .get() as { seq: number; recordHash: string }
    const resigned = signChainHeadAnchor(privateKey.privateKeyPem, {
      formatVersion: 1,
      seq: row.seq,
      recordHash: row.recordHash,
      signedAt: new Date().toISOString(),
    })
    const { loadSigningPublicKey } = await import('../../src/journal/signing.js')
    const publicKeyPem = await loadSigningPublicKey(journalDir)
    expect(publicKeyPem).not.toBeNull()
    expect(
      verifyChainHeadAnchorSignature(publicKeyPem as string, resigned.anchor, resigned.signatureBase64),
    ).toBe(true)
  })
})

describe('verify --sign: a broken chain', () => {
  test('still reports BROKEN (exit 2); the anchor covers only the current stored head, honestly caveated', async () => {
    await writeRecordsViaSink('session-a', [
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA1', 'tools/call'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA2', 'ping'),
    ])
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    handle.db.prepare('UPDATE journal_records SET doc = ? WHERE seq = 2').run('{"tampered":true}')
    await keygen()
    const io = fakeIo()

    const exitCode = await run(['--sign'], io)

    expect(exitCode).toBe(2)
    expect(io.out()).toMatch(/BROKEN at seq 2/)
    expect(io.out()).toMatch(/signature/i)
  })
})

describe('private key material never leaks through verify --sign', () => {
  test('neither stdout nor stderr ever contain the private key PEM body', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])
    await keygen()
    const privateKey = await loadSigningPrivateKey(journalDir)
    if (!privateKey.present) throw new Error('test setup: key missing')
    const io = fakeIo()

    await run(['--sign'], io)

    expect(io.out()).not.toContain(privateKey.privateKeyPem)
    expect(io.err()).not.toContain(privateKey.privateKeyPem)
  })
})
