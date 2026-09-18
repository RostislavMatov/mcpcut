import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runKeygenCommand } from '../../src/cli/keygen-cmd.js'
import { publicKeyFingerprint, signingKeyPathFor, signingPubPathFor } from '../../src/journal/signing.js'

/**
 * `mcpcut keygen` (M5 wave 4, task 4.2): the operator-facing half of
 * `journal/signing.ts`'s key generation. Real tmpdir, real Ed25519 keys --
 * no crypto mocks.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-keygen-cmd-'))
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
  return runKeygenCommand(args, io, { journalDir })
}

describe('keygen: first run', () => {
  test('exit 0, writes both files, prints the public key to stdout', async () => {
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toMatch(/-----BEGIN PUBLIC KEY-----/)
    expect(io.err()).toBe('')

    const privateMode = (await stat(signingKeyPathFor(journalDir))).mode & 0o777
    expect(privateMode).toBe(0o600)
    const publicPem = await readFile(signingPubPathFor(journalDir), 'utf8')
    expect(publicPem).toMatch(/-----BEGIN PUBLIC KEY-----/)

    // The one thing that must never happen on the success path either (M5
    // wave 4, task 4.4): the private key is written straight to disk and is
    // never echoed, not even alongside the public key it is legitimate to print.
    const privatePem = await readFile(signingKeyPathFor(journalDir), 'utf8')
    expect(io.out()).not.toContain(privatePem)
    expect(io.out()).not.toMatch(/-----BEGIN PRIVATE KEY-----/)
  })

  // Review finding: an anchor alone had no field identifying which key
  // produced it, and an operator handing a public key to an auditor had no
  // matching identifier to hand over alongside it either. Printed here, at
  // generation time, not only inside a later `verify --sign` anchor -- an
  // auditor (or an operator running several journal directories) needs to
  // tell keys apart before any anchor has ever been signed with this one.
  test('prints the public key fingerprint alongside the PEM', async () => {
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(0)
    const publicPem = await readFile(signingPubPathFor(journalDir), 'utf8')
    const expectedFingerprint = publicKeyFingerprint(publicPem)
    expect(expectedFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(io.out()).toContain(expectedFingerprint)
  })
})

describe('keygen: refuses to overwrite', () => {
  test('a second run exits non-zero, leaves the existing key untouched, and never prints the private key', async () => {
    await run([])
    const originalPrivatePem = await readFile(signingKeyPathFor(journalDir), 'utf8')
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).not.toBe(0)
    expect(io.err()).toMatch(/refus/i)
    const afterPrivatePem = await readFile(signingKeyPathFor(journalDir), 'utf8')
    expect(afterPrivatePem).toBe(originalPrivatePem)
    expect(io.out()).not.toContain(originalPrivatePem)
    expect(io.err()).not.toContain(originalPrivatePem)
  })
})

describe('keygen: stray arguments', () => {
  test('rejected with a usage message, exit non-zero', async () => {
    const io = fakeIo()

    const exitCode = await run(['bogus'], io)

    expect(exitCode).not.toBe(0)
    expect(io.err().length).toBeGreaterThan(0)
  })
})
