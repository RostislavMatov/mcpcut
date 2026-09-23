import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runExportCommand } from '../../src/cli/export-cmd.js'
import { writeAllBytes } from '../../src/cli/report-cmd.js'
import { runKeygenCommand } from '../../src/cli/keygen-cmd.js'
import { journalDbPathFor, openJournalDbShared } from '../../src/journal/db.js'
import { AS_OF_CONTRACT, REPORT_FILES, type ReportManifest } from '../../src/journal/report.js'
import { verifyReportManifestSignature, type ReportSignatureFile } from '../../src/journal/report-signing.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { buildPoolRecord } from '../../src/journal/pool-record.js'
import { createJournalSink } from '../../src/journal/sink.js'
import { loadSigningPublicKey, publicKeyFingerprint } from '../../src/journal/signing.js'

/**
 * `mcpcut export --report [--session <id>] [--out <dir>]` (M5 wave 5,
 * task 5.1, part B). Companion to `tests/cli/export-cmd.test.ts` (plain
 * `export`, untouched) and `tests/journal/report.test.ts` (the format core
 * this command builds on).
 */

let journalDir: string
let outDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-export-report-cmd-journal-'))
  const outParent = await mkdtemp(join(tmpdir(), 'mcpcut-export-report-cmd-out-'))
  outDir = join(outParent, 'report')
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
  await rm(outDir, { recursive: true, force: true })
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
  return runExportCommand(args, io, { journalDir })
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

async function readManifest(): Promise<ReportManifest> {
  const text = await readFile(join(outDir, REPORT_FILES.manifest), 'utf8')
  return JSON.parse(text) as ReportManifest
}

async function readRecordsBytes(): Promise<Buffer> {
  return readFile(join(outDir, REPORT_FILES.records))
}

async function existsAt(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('export --report: unsigned end to end', () => {
  test('writes an unsigned report, warns on stderr, exit 0', async () => {
    await writeRecordsViaSink('session-a', [
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA1', 'tools/call'),
    ])
    const io = fakeIo()

    const exitCode = await run(['--report', '--out', outDir], io)

    expect(exitCode).toBe(0)
    expect(io.err()).toMatch(/no signing key|keygen/i)
    expect(io.out()).toContain(outDir)
    expect(io.out()).toMatch(/UNSIGNED/)

    const files = (await readdir(outDir)).sort()
    expect(files).toEqual([REPORT_FILES.manifest, REPORT_FILES.records, REPORT_FILES.summary].sort())

    const manifest = await readManifest()
    expect(manifest.formatVersion).toBe(1)
    expect(manifest.keyFingerprint).toBeUndefined()
    expect(manifest.contract).toBe(AS_OF_CONTRACT)
    expect(manifest.counts.records).toBe(2)

    const recordsBytes = await readRecordsBytes()
    expect(createHash('sha256').update(recordsBytes).digest('hex')).toBe(manifest.records.sha256)
    expect(manifest.records.lineCount).toBe(2)
  })

  test('report.json is 2-space indented with a trailing newline', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])

    const exitCode = await run(['--report', '--out', outDir])

    expect(exitCode).toBe(0)
    const text = await readFile(join(outDir, REPORT_FILES.manifest), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  "formatVersion"')
  })
})

describe('export --report: signed after keygen', () => {
  test('writes a valid signature.json, keyFingerprint on the manifest matches', async () => {
    await writeRecordsViaSink('session-a', [
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA1', 'tools/call'),
    ])
    await keygen()
    const io = fakeIo()

    const exitCode = await run(['--report', '--out', outDir], io)

    expect(exitCode).toBe(0)
    expect(io.err()).toBe('')
    expect(io.out()).not.toMatch(/UNSIGNED/)

    const files = (await readdir(outDir)).sort()
    expect(files).toEqual(
      [REPORT_FILES.manifest, REPORT_FILES.records, REPORT_FILES.summary, REPORT_FILES.signature].sort(),
    )

    const manifest = await readManifest()
    const signatureText = await readFile(join(outDir, REPORT_FILES.signature), 'utf8')
    const signature = JSON.parse(signatureText) as ReportSignatureFile
    expect(signature.algorithm).toBe('ed25519')
    expect(manifest.keyFingerprint).toBe(signature.keyFingerprint)

    const publicKeyPem = await loadSigningPublicKey(journalDir)
    expect(publicKeyPem).not.toBeNull()
    expect(signature.keyFingerprint).toBe(publicKeyFingerprint(publicKeyPem as string))
    expect(
      verifyReportManifestSignature(publicKeyPem as string, manifest, signature.signatureBase64),
    ).toBe(true)
    expect(io.out()).toContain(signature.keyFingerprint)
  })
})

describe('export --report: --session scope', () => {
  test('exports only the matching session', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list')])
    await writeRecordsViaSink('session-b', [recordOf('session-b', '01BBBBBBBBBBBBBBBBBBBBBBB0', 'ping')])

    const exitCode = await run(['--report', '--session', 'session-b', '--out', outDir])

    expect(exitCode).toBe(0)
    const manifest = await readManifest()
    expect(manifest.scope.session).toBe('session-b')
    expect(manifest.sessionIds).toEqual(['session-b'])
    const recordsText = await readFile(join(outDir, REPORT_FILES.records), 'utf8')
    const lines = recordsText.split('\n').filter((line) => line.length > 0)
    expect(lines).toHaveLength(1)
    expect((JSON.parse(lines[0]!) as JournalRecord).sessionId).toBe('session-b')
  })
})

describe('export --report: refuses a non-empty out dir', () => {
  test('exit 1, clear stderr message, existing contents untouched', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, 'stray.txt'), 'pre-existing\n', 'utf8')
    const io = fakeIo()

    const exitCode = await run(['--report', '--out', outDir], io)

    expect(exitCode).toBe(1)
    expect(io.err().length).toBeGreaterThan(0)
    const files = await readdir(outDir)
    expect(files).toEqual(['stray.txt'])
  })
})

describe('export --report: no database at all', () => {
  test('exit 1, writes nothing to disk', async () => {
    const io = fakeIo()

    const exitCode = await run(['--report', '--out', outDir], io)

    expect(exitCode).toBe(1)
    expect(io.err().length).toBeGreaterThan(0)
    expect(await existsAt(outDir)).toBe(false)
  })
})

describe('export --report: empty journal', () => {
  test('a valid report with zero records, exit 0', async () => {
    await openJournalDbShared(journalDbPathFor(journalDir))

    const exitCode = await run(['--report', '--out', outDir])

    expect(exitCode).toBe(0)
    const manifest = await readManifest()
    expect(manifest.counts.records).toBe(0)
    expect(manifest.seqRange).toBeNull()
    expect(manifest.chain.head).toBeNull()
    const recordsText = await readFile(join(outDir, REPORT_FILES.records), 'utf8')
    expect(recordsText).toBe('')
  })
})

describe('export --report: unknown --session', () => {
  test('exit 1, writes nothing to disk', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])
    const io = fakeIo()

    const exitCode = await run(['--report', '--session', 'session-does-not-exist', '--out', outDir], io)

    expect(exitCode).toBe(1)
    expect(io.err().length).toBeGreaterThan(0)
    expect(await existsAt(outDir)).toBe(false)
  })
})

describe('export --report: file modes', () => {
  test('every written file is 0600', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])
    await keygen()

    const exitCode = await run(['--report', '--out', outDir])

    expect(exitCode).toBe(0)
    for (const file of Object.values(REPORT_FILES)) {
      const info = await stat(join(outDir, file))
      expect(info.mode & 0o777).toBe(0o600)
    }
  })
})

describe('export --report: default --out', () => {
  test('defaults to mcpcut-report under the process cwd', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])
    const cwdReport = join(process.cwd(), 'mcpcut-report')
    await rm(cwdReport, { recursive: true, force: true })
    const io = fakeIo()

    try {
      const exitCode = await run(['--report'], io)
      expect(exitCode).toBe(0)
      expect(io.out()).toContain(cwdReport)
      expect(await existsAt(join(cwdReport, REPORT_FILES.manifest))).toBe(true)
    } finally {
      await rm(cwdReport, { recursive: true, force: true })
    }
  })
})

describe('export: --out without --report', () => {
  test('is a usage error, not a silently ignored flag: exit 1, nothing written, no stdout', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])
    const io = fakeIo()

    const exitCode = await run(['--out', outDir], io)

    expect(exitCode).toBe(1)
    expect(io.out()).toBe('')
    expect(io.err()).toMatch(/--out/)
    expect(io.err()).toMatch(/--report/)
    expect(io.err()).toContain('export --report --out')
    expect(await existsAt(outDir)).toBe(false)
  })
})

describe('export --report: plain export is unaffected', () => {
  test('export without --report still streams JSONL to stdout, no directory created', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])
    const io = fakeIo()

    const exitCode = await run([], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('session-a')
    expect(await existsAt(outDir)).toBe(false)
  })
})

/**
 * Wave-5 review findings, CLI side. Each block reproduces what the reviewers
 * observed against the pre-fix build and then pins the fixed behaviour.
 */

/** A decision record whose `argsHash` is absent -- the shape `line-source.ts` never validated. */
function decisionRecordWithoutArgsHash(sessionId: string, id: string): JournalRecord {
  return {
    id,
    ts: new Date().toISOString(),
    sessionId,
    direction: 'client→server',
    kind: 'decision',
    method: 'tools/call',
    payload: null,
    decision: { outcome: 'allow', rule: 'read-allow', toolName: 'files.read' } as never,
  }
}

describe('export --report: a failed export leaves nothing of its own behind (P2)', () => {
  test('the same command can be re-run after a failure inside a directory it created', async () => {
    // REPRODUCED before the fix: the export crashed on the record below,
    // exited 1 leaving records.jsonl behind, and the retry then refused with
    // "the directory already exists and is not empty" -- the operator could
    // not re-run the same command at all. The crash itself is fixed too, so
    // this now simply succeeds twice; the directory-hygiene half is asserted
    // in the sibling test below with a forced failure.
    await writeRecordsViaSink('session-a', [decisionRecordWithoutArgsHash('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0')])

    expect(await run(['--report', '--out', outDir])).toBe(0)
    const summary = await readFile(join(outDir, REPORT_FILES.summary), 'utf8')
    expect(summary).toContain('(absent)')
  })

  test('removes the directory it created when the export fails, so the retry is not refused', async () => {
    // The forced failure: a row whose stored doc holds a raw newline, which
    // records.jsonl cannot represent (see the P3 block in report.test.ts).
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    handle.db.prepare('UPDATE journal_records SET doc = ? WHERE seq = 1').run('{"a":1}\n{"b":2}')
    const io = fakeIo()

    const exitCode = await run(['--report', '--out', outDir], io)

    expect(exitCode).toBe(1)
    expect(io.out()).not.toContain('Report written to')
    expect(io.err()).toMatch(/seq 1/)
    expect(io.err()).toMatch(/mcpcut verify/)
    expect(await existsAt(outDir)).toBe(false)
  })

  test('removes only the files it wrote when the directory already existed', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    handle.db.prepare('UPDATE journal_records SET doc = ? WHERE seq = 1').run('{"a":1}\n{"b":2}')
    await mkdir(outDir, { recursive: true })

    const exitCode = await run(['--report', '--out', outDir])

    expect(exitCode).toBe(1)
    // The operator's own directory survives; only this command's artifacts go.
    expect(await existsAt(outDir)).toBe(true)
    expect(await readdir(outDir)).toEqual([])
  })
})

describe('export --report: the output directory (P8)', () => {
  test('tightens a pre-existing world-writable directory to 0700 before writing into it', async () => {
    // REPRODUCED: mkdir's `mode` applies only to directories it CREATES, so a
    // 0777 --out stayed 0777 while README states the export directory is
    // created at 0700 -- another local user could list and replace entries
    // before handoff.
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])
    await mkdir(outDir, { recursive: true })
    await chmod(outDir, 0o777)

    const exitCode = await run(['--report', '--out', outDir])

    expect(exitCode).toBe(0)
    expect((await stat(outDir)).mode & 0o777).toBe(0o700)
  })

  test('creates a fresh directory at 0700', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])

    expect(await run(['--report', '--out', outDir])).toBe(0)

    expect((await stat(outDir)).mode & 0o777).toBe(0o700)
  })

  test('refuses a symlinked --out instead of silently following it', async () => {
    // REPRODUCED: the files landed in the link's target, not where the
    // operator was told they went.
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])
    const real = join(journalDir, 'elsewhere')
    await mkdir(real, { recursive: true })
    await symlink(real, outDir)
    const io = fakeIo()

    const exitCode = await run(['--report', '--out', outDir], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toMatch(/symbolic link/i)
    expect(await readdir(real)).toEqual([])
  })

  test('prints the resolved real path, not the path as typed', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])
    const io = fakeIo()

    const exitCode = await run(['--report', '--out', join(outDir, '..', 'report')], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain(`Report written to: ${await realpath(outDir)}`)
  })
})

describe('export --report: an unusable --out stays inside the command error path (P12)', () => {
  test('--out pointing at a FILE is a reported refusal, not an escaped ENOTDIR', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])
    await writeFile(outDir, 'not a directory')
    const io = fakeIo()

    const exitCode = await run(['--report', '--out', outDir], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toMatch(/not a directory/i)
  })

  test('an unreadable --out directory is a reported failure, not an escaped EACCES', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])
    await mkdir(outDir, { recursive: true })
    await mkdir(join(outDir, 'child'), { recursive: true })
    await chmod(outDir, 0o000)
    const io = fakeIo()
    try {
      const exitCode = await run(['--report', '--out', outDir], io)

      expect(exitCode).toBe(1)
      expect(io.err()).toContain('export --report failed')
    } finally {
      await chmod(outDir, 0o700)
    }
  })
})

describe('export --report: a chain break is impossible to miss on stdout (P13)', () => {
  test('still exits 0, but says on stdout that the chain did not verify', async () => {
    await writeRecordsViaSink('session-a', [
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping'),
      recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA1', 'ping'),
    ])
    const handle = await openJournalDbShared(journalDbPathFor(journalDir))
    handle.db.prepare('UPDATE journal_records SET doc = ? WHERE seq = 2').run('{"tampered":true}')
    const io = fakeIo()

    const exitCode = await run(['--report', '--out', outDir], io)

    // The export DID succeed and the manifest carries the finding, so the
    // exit code is unchanged -- but a boolean field is not something an
    // operator reads at 2am.
    expect(exitCode).toBe(0)
    expect(io.out()).toMatch(/WARNING/)
    expect(io.out()).toMatch(/did NOT verify/)
    expect(io.out()).toMatch(/seq 2/)
    const manifest = await readManifest()
    expect(manifest.chain.verifiedAtExport).toBe(false)
  })
})

describe('export --report: the manifest attests summary.md (A1/P4)', () => {
  test('summary.sha256 is the digest of the exact bytes on disk', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])

    expect(await run(['--report', '--out', outDir])).toBe(0)

    const manifest = await readManifest()
    const summaryBytes = await readFile(join(outDir, REPORT_FILES.summary))
    expect(manifest.summary.file).toBe(REPORT_FILES.summary)
    expect(createHash('sha256').update(summaryBytes).digest('hex')).toBe(manifest.summary.sha256)
  })

  test('the signature covers the summary digest: editing summary.md alone breaks nothing else, but is detectable', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'ping')])
    await keygen()

    expect(await run(['--report', '--out', outDir])).toBe(0)

    const manifest = await readManifest()
    const signature = JSON.parse(
      await readFile(join(outDir, REPORT_FILES.signature), 'utf8'),
    ) as ReportSignatureFile
    const publicKeyPem = await loadSigningPublicKey(journalDir)
    if (publicKeyPem === null) throw new Error('test setup: keygen wrote no public key')
    // The manifest that verifies is the one carrying the summary digest.
    expect(verifyReportManifestSignature(publicKeyPem, manifest, signature.signatureBase64)).toBe(true)
    await writeFile(join(outDir, REPORT_FILES.summary), 'edited by someone downstream\n')
    const edited = await readFile(join(outDir, REPORT_FILES.summary))
    expect(createHash('sha256').update(edited).digest('hex')).not.toBe(manifest.summary.sha256)
  })
})

describe('writeAllBytes: short writes are never ignored (P5)', () => {
  test('loops until every byte of the string is written', async () => {
    // REPRODUCED structurally: the first cut discarded `bytesWritten` and
    // `fs.write` does not loop, so a truncated records.jsonl still printed
    // "Report written to: ..." and exited 0. A real short write needs a
    // signal mid-syscall; this injects the same condition at the seam.
    const chunks: string[] = []
    const sink = {
      write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }> {
        const accepted = Math.min(3, length)
        chunks.push(Buffer.from(buffer).subarray(offset, offset + accepted).toString('utf8'))
        return Promise.resolve({ bytesWritten: accepted })
      },
    }

    await writeAllBytes(sink, 'a longer line than three bytes\n')

    expect(chunks.join('')).toBe('a longer line than three bytes\n')
  })

  test('counts bytes, not characters, so a multi-byte value is not truncated', async () => {
    const written: number[] = []
    const sink = {
      write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }> {
        const accepted = Math.min(2, length)
        for (const byte of Buffer.from(buffer).subarray(offset, offset + accepted)) written.push(byte)
        return Promise.resolve({ bytesWritten: accepted })
      },
    }
    const text = 'client→server ✓\n'

    await writeAllBytes(sink, text)

    expect(Buffer.from(written).toString('utf8')).toBe(text)
  })

  test('fails loudly rather than spinning when the destination accepts nothing', async () => {
    const sink = {
      write(): Promise<{ bytesWritten: number }> {
        return Promise.resolve({ bytesWritten: 0 })
      },
    }

    await expect(writeAllBytes(sink, 'anything')).rejects.toThrow(/write stalled/)
  })
})

/**
 * ADR-0015 phase 5 (R3): the export names how many pool sessions it saw, and
 * an export of a pool session alone says where that session's decisions are.
 */
describe('export --report: pool sessions on stdout', () => {
  async function writePoolSession(): Promise<void> {
    await writeRecordsViaSink('pool-p', [
      buildPoolRecord({ sessionId: 'pool-p', pool: { agentName: 'bot', event: 'open', members: ['alpha', 'beta'] } }),
      buildPoolRecord({
        sessionId: 'pool-p',
        pool: { agentName: 'bot', event: 'attach', serverName: 'alpha', childSessionId: 'child-a' },
      }),
      buildPoolRecord({
        sessionId: 'pool-p',
        pool: { agentName: 'bot', event: 'attach', serverName: 'beta', childSessionId: 'child-b' },
      }),
    ])
    await writeRecordsViaSink('child-a', [recordOf('child-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/call')])
  }

  test('states a zero count on a journal without pools', async () => {
    await writeRecordsViaSink('session-a', [recordOf('session-a', '01AAAAAAAAAAAAAAAAAAAAAAA0', 'tools/list')])
    const io = fakeIo()

    expect(await run(['--report', '--out', outDir], io)).toBe(0)

    expect(io.out()).toContain('Pool sessions: 0\n')
    expect(io.out()).not.toContain('Note:')
  })

  test('counts the pool sessions of a whole-journal export without a note', async () => {
    await writePoolSession()
    const io = fakeIo()

    expect(await run(['--report', '--out', outDir], io)).toBe(0)

    expect(io.out()).toContain('Pool sessions: 1\n')
    expect(io.out()).not.toContain('Note:')
  })

  test('says where the decisions are when only the pool session is exported', async () => {
    await writePoolSession()
    const io = fakeIo()

    expect(await run(['--report', '--session', 'pool-p', '--out', outDir], io)).toBe(0)

    expect(io.out()).toContain('Pool sessions: 1\n')
    expect(io.out()).toContain(
      'Note: session pool-p is a pool session; its decisions are in 2 child session(s) this export ' +
        'does not include. Export the whole journal (no --session) to include them.\n',
    )
    const summary = await readFile(join(outDir, REPORT_FILES.summary), 'utf8')
    expect(summary).toContain('- Not in this export: child session(s) child-a, child-b')
  })

  test('keeps report.json free of any pool field', async () => {
    await writePoolSession()

    expect(await run(['--report', '--out', outDir])).toBe(0)

    const manifest = await readManifest()
    expect(Object.keys(manifest).sort()).toEqual(
      ['asOf', 'chain', 'contract', 'counts', 'formatVersion', 'records', 'scope', 'seqRange', 'sessionIds', 'summary'],
    )
    expect(manifest.formatVersion).toBe(1)
  })
})
