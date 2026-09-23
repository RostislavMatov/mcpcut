import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runExportCommand } from '../../src/cli/export-cmd.js'
import { runKeygenCommand } from '../../src/cli/keygen-cmd.js'
import { runVerifyCommand } from '../../src/cli/verify-cmd.js'
import {
  insertRecordRows,
  journalDbPathFor,
  openJournalDbShared,
  type JournalRecordRow,
} from '../../src/journal/db.js'
import { REPORT_FILES, buildJournalReport, type ReportManifest } from '../../src/journal/report.js'
import { buildPoolRecord } from '../../src/journal/pool-record.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { signReportManifest } from '../../src/journal/report-signing.js'
import { createJournalSink } from '../../src/journal/sink.js'
import {
  generateAndWriteSigningKeyPair,
  loadSigningPrivateKey,
} from '../../src/journal/signing.js'

/**
 * `mcpcut verify --report <dir> [--pub <path>]` (M5 wave 5, task 5.3) --
 * the auditor's procedure, end to end and with NO database open.
 *
 * Export directories here are produced by the real library
 * (`buildJournalReport` + `signReportManifest`) and written to disk exactly
 * as the exporting command does, then tampered with on disk the way a
 * tamperer would: edit a byte, drop a line, retouch a manifest field. The
 * assertions are about the two things an auditor actually consumes -- the
 * exit code their script branches on, and whether the output states plainly
 * what was NOT checked.
 */

let journalDir: string
let reportDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-verify-report-home-'))
  reportDir = await mkdtemp(join(tmpdir(), 'mcpcut-verify-report-dir-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
  await rm(reportDir, { recursive: true, force: true })
})

function fakeIo(): {
  stdout: { write: (chunk: string) => void }
  stderr: { write: (chunk: string) => void }
  out: () => string
  err: () => string
  all: () => string
} {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
    all: () => outChunks.join('') + errChunks.join(''),
  }
}

function run(args: string[], io = fakeIo()): Promise<number> {
  return runVerifyCommand(args, io, { journalDir })
}

function rowOf(doc: string, sessionId = 'session-1'): JournalRecordRow {
  return {
    sessionId,
    recordId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: '2026-08-18T00:00:00.000Z',
    direction: 'client→server',
    kind: 'notification',
    method: 'tools/list',
    doc,
  }
}

function trafficDoc(sessionId: string, id: string): string {
  return JSON.stringify({
    id,
    ts: '2026-08-18T00:00:00.000Z',
    sessionId,
    direction: 'client→server',
    kind: 'notification',
    method: 'tools/list',
    payload: { hello: 'world' },
  })
}

interface WriteExportOptions {
  readonly session?: string
  readonly sign?: boolean
  /** Where to keygen; defaults to `journalDir` so the `--pub` default resolves. */
  readonly keyDir?: string
}

/** Writes a real export directory, byte for byte as the exporting command does. */
async function writeExport(options: WriteExportOptions = {}): Promise<ReportManifest> {
  const handle = await openJournalDbShared(journalDbPathFor(journalDir))
  handle.transaction((db) =>
    insertRecordRows(db, [
      rowOf(trafficDoc('session-1', 'a')),
      rowOf(trafficDoc('session-1', 'b')),
      rowOf(trafficDoc('session-2', 'c'), 'session-2'),
    ]),
  )

  const lines: string[] = []
  const built = await buildJournalReport(
    handle,
    options.session === undefined
      ? { asOf: '2026-08-18T12:00:00.000Z' }
      : { asOf: '2026-08-18T12:00:00.000Z', session: options.session },
    { writeLine: (line) => void lines.push(line) },
  )
  await writeFile(join(reportDir, REPORT_FILES.records), lines.join(''), 'utf8')
  await writeFile(join(reportDir, REPORT_FILES.summary), built.summaryMarkdown, 'utf8')

  if (options.sign !== true) {
    await writeManifest(built.manifest)
    return built.manifest
  }

  const keyDir = options.keyDir ?? journalDir
  await generateAndWriteSigningKeyPair(keyDir)
  const lookup = await loadSigningPrivateKey(keyDir)
  if (!lookup.present) throw new Error('fixture keygen wrote no private key')
  const signed = signReportManifest(lookup.privateKeyPem, built.manifest)
  await writeManifest(signed.manifest)
  await writeFile(
    join(reportDir, REPORT_FILES.signature),
    `${JSON.stringify(signed.signature, null, 2)}\n`,
    'utf8',
  )
  return signed.manifest
}

async function writeManifest(manifest: ReportManifest): Promise<void> {
  await writeFile(join(reportDir, REPORT_FILES.manifest), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/** Re-reads, edits and re-writes `report.json` the way someone with a text editor would. */
async function editManifestOnDisk(edit: (raw: Record<string, unknown>) => void): Promise<void> {
  const path = join(reportDir, REPORT_FILES.manifest)
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  edit(raw)
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
}

describe('verify --report: an intact export', () => {
  test('a signed, untouched export exits 0 and reports every check', async () => {
    await writeExport({ sign: true })
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('records.jsonl digest')
    expect(io.out()).toContain('records.jsonl line count')
    expect(io.out()).toContain('chain re-fold')
    expect(io.out()).toContain('manifest signature')
    expect(io.out()).not.toContain('[FAIL]')
  })

  test('states plainly that this proves bytes, not that the host was untampered', async () => {
    await writeExport({ sign: true })
    const io = fakeIo()

    await run(['--report', reportDir], io)

    expect(io.out()).toContain('OUT OF BAND')
  })

  test('never opens or creates a journal database', async () => {
    const emptyHome = await mkdtemp(join(tmpdir(), 'mcpcut-no-db-'))
    try {
      await writeExport()
      const io = fakeIo()

      const exitCode = await runVerifyCommand(['--report', reportDir], io, { journalDir: emptyHome })

      expect(exitCode).toBe(0)
      await expect(readFile(journalDbPathFor(emptyHome), 'utf8')).rejects.toThrow()
    } finally {
      await rm(emptyHome, { recursive: true, force: true })
    }
  })

  test('accepts an explicit --pub path, which is the real auditor case', async () => {
    const keyHome = await mkdtemp(join(tmpdir(), 'mcpcut-key-home-'))
    try {
      await writeExport({ sign: true, keyDir: keyHome })
      const handedOverPub = join(reportDir, 'handed-over.pub')
      await writeFile(handedOverPub, await readFile(join(keyHome, 'signing.pub'), 'utf8'), 'utf8')
      const io = fakeIo()

      const exitCode = await run(['--report', reportDir, '--pub', handedOverPub], io)

      expect(exitCode).toBe(0)
    } finally {
      await rm(keyHome, { recursive: true, force: true })
    }
  })
})

describe('verify --report: a check fails (exit 2)', () => {
  test('one flipped byte in records.jsonl exits 2', async () => {
    await writeExport({ sign: true })
    const path = join(reportDir, REPORT_FILES.records)
    await writeFile(path, (await readFile(path, 'utf8')).replace('world', 'w0rld'), 'utf8')
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    expect(exitCode).toBe(2)
    expect(io.out()).toContain('[FAIL]')
  })

  test('an altered manifest field breaks the signature and exits 2', async () => {
    await writeExport({ sign: true })
    await editManifestOnDisk((raw) => {
      raw['asOf'] = '2020-01-01T00:00:00.000Z'
    })
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    expect(exitCode).toBe(2)
    expect(io.out()).toContain('signature')
  })

  test("verification against a DIFFERENT installation's public key exits 2", async () => {
    const otherHome = await mkdtemp(join(tmpdir(), 'mcpcut-other-home-'))
    try {
      await writeExport({ sign: true })
      await generateAndWriteSigningKeyPair(otherHome)
      const io = fakeIo()

      const exitCode = await run(['--report', reportDir, '--pub', join(otherHome, 'signing.pub')], io)

      expect(exitCode).toBe(2)
      expect(io.out()).toContain('fingerprint')
    } finally {
      await rm(otherHome, { recursive: true, force: true })
    }
  })

  test('a truncated records.jsonl (line count mismatch) exits 2', async () => {
    await writeExport()
    const path = join(reportDir, REPORT_FILES.records)
    const lines = (await readFile(path, 'utf8')).split('\n').slice(0, -1)
    await writeFile(path, `${lines.slice(0, -1).join('\n')}\n`, 'utf8')
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    expect(exitCode).toBe(2)
    expect(io.out()).toContain('line count')
  })

  test('a self-inconsistent manifest exits 2, not 1', async () => {
    await writeExport()
    await editManifestOnDisk((raw) => {
      ;(raw['counts'] as Record<string, unknown>)['records'] = 99
    })
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    expect(exitCode).toBe(2)
    expect(io.out()).toContain('counts.records')
  })

  test('a failed check wins over a could-not-run: no key AND tampered bytes exits 2', async () => {
    const keyHome = await mkdtemp(join(tmpdir(), 'mcpcut-key-away-'))
    try {
      await writeExport({ sign: true, keyDir: keyHome })
      const path = join(reportDir, REPORT_FILES.records)
      await writeFile(path, (await readFile(path, 'utf8')).replace('world', 'w0rld'), 'utf8')
      const io = fakeIo()

      // No signing.pub under `journalDir`, so the signature check cannot run.
      const exitCode = await run(['--report', reportDir], io)

      expect(exitCode).toBe(2)
    } finally {
      await rm(keyHome, { recursive: true, force: true })
    }
  })
})

describe('verify --report: an unsigned export', () => {
  test('exits 0 and says UNSIGNED, never verified-and-signed', async () => {
    await writeExport()
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('UNSIGNED')
  })
})

describe('verify --report: could not run (exit 1)', () => {
  test('a missing directory exits 1 and names the path', async () => {
    const missing = join(reportDir, 'nope')
    const io = fakeIo()

    const exitCode = await run(['--report', missing], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(missing)
  })

  test('a directory with no report.json exits 1', async () => {
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(REPORT_FILES.manifest)
  })

  test('an unsupported formatVersion exits 1 and names the field', async () => {
    await writeExport()
    await editManifestOnDisk((raw) => {
      raw['formatVersion'] = 2
    })
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('formatVersion')
  })

  test('a malformed manifest exits 1 and names the offending field', async () => {
    await writeExport()
    await editManifestOnDisk((raw) => {
      delete (raw['records'] as Record<string, unknown>)['sha256']
    })
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('records.sha256')
  })

  /**
   * AMENDED (wave-5 review, amendment A6). This test used to assert exit 1
   * for a DELETED records.jsonl, on the frozen contract's "missing files ->
   * could not run" rule. That was wrong, and the moved assertion below is
   * the point: the manifest names records.jsonl and attests a digest and a
   * line count over it, so its absence contradicts a positive claim rather
   * than leaving a question unanswered. Under the old rule an auditor's
   * `verify --report || alert` pipeline treated deletion of the EVIDENCE
   * file as "retry later" while deletion of the far less important
   * summary.md raised the alarm. What the manifest does not claim -- the
   * directory itself, report.json -- still exits 1; see the tests above.
   */
  test('a missing records.jsonl exits 2: the manifest attests a file that is not there', async () => {
    await writeExport()
    await rm(join(reportDir, REPORT_FILES.records))
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    expect(exitCode).toBe(2)
    expect(io.out()).toContain('[FAIL]')
    expect(io.out()).toContain('records.jsonl digest')
  })

  test('signature.json present but no public key file exits 1, not 2', async () => {
    const keyHome = await mkdtemp(join(tmpdir(), 'mcpcut-key-elsewhere-'))
    try {
      await writeExport({ sign: true, keyDir: keyHome })
      const io = fakeIo()

      const exitCode = await run(['--report', reportDir], io)

      expect(exitCode).toBe(1)
      expect(io.all()).toContain('signing.pub')
    } finally {
      await rm(keyHome, { recursive: true, force: true })
    }
  })

  test('a --pub file that is not a public key exits 1', async () => {
    await writeExport({ sign: true })
    const junk = join(reportDir, 'junk.pub')
    await writeFile(junk, 'definitely not a PEM\n', 'utf8')
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir, '--pub', junk], io)

    expect(exitCode).toBe(1)
  })
})

describe('verify --report: usage errors', () => {
  test('--report with --sign is rejected: --sign is a database mode', async () => {
    await writeExport()
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir, '--sign'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('--sign')
    expect(io.err()).toContain('database')
  })

  test('--report with --session is rejected: --session is a database mode', async () => {
    await writeExport()
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir, '--session', 'session-1'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('--session')
  })

  test('--pub without --report is rejected', async () => {
    const io = fakeIo()

    const exitCode = await run(['--pub', join(journalDir, 'signing.pub')], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('--pub')
  })
})

describe('verify --report: a session-scoped export', () => {
  test('exits 0 but says the chain is not re-derivable from this export, and why', async () => {
    await writeExport({ session: 'session-1' })
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('NOT CHECKED')
    expect(io.out()).toContain('session-1')
  })
})

/**
 * The wave-5 review round, end to end. Each block below is one reviewer
 * reproduction, replayed against the command an auditor actually runs -- the
 * exit code their script branches on, and whether the output states plainly
 * what was and was not established.
 */
describe('verify --report: a smuggled __proto__ key (V1)', () => {
  test('an injected __proto__ in a SIGNED manifest is refused, not verified clean', async () => {
    await writeExport({ sign: true })
    const path = join(reportDir, REPORT_FILES.manifest)
    const raw = await readFile(path, 'utf8')
    await writeFile(
      path,
      raw.replace(
        '{\n',
        '{\n  "__proto__": {"auditorNote": "scope excludes sessions under legal hold", "contract": "VOID"},\n',
      ),
      'utf8',
    )
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    // Before the fix: exit 0, "[PASS] manifest signature: valid ed25519
    // signature over the manifest", RESULT: PASSED -- because zod dropped the
    // key and the signature was checked over bytes that were not the file's.
    expect(exitCode).not.toBe(0)
    expect(io.out()).not.toContain('RESULT: PASSED')
    expect(io.err()).toContain('__proto__')
  })
})

describe('verify --report: the recomputable off switch (V3)', () => {
  test('a record deleted with every number "fixed" and the flag flipped still exits 2', async () => {
    await writeExport()
    const recordsPath = join(reportDir, REPORT_FILES.records)
    const lines = (await readFile(recordsPath, 'utf8')).split('\n').slice(0, -1)
    const kept = `${lines.slice(0, -1).join('\n')}\n`
    await writeFile(recordsPath, kept, 'utf8')
    await editManifestOnDisk((raw) => {
      const records = raw['records'] as Record<string, unknown>
      records['lineCount'] = lines.length - 1
      records['sha256'] = createHash('sha256').update(Buffer.from(kept, 'utf8')).digest('hex')
      ;(raw['counts'] as Record<string, unknown>)['records'] = lines.length - 1
      const chain = raw['chain'] as Record<string, unknown>
      chain['recomputable'] = false
      delete chain['startPrevHash']
      raw['sessionIds'] = ['session-1']
    })
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    expect(exitCode).toBe(2)
    expect(io.out()).toContain('chain.recomputable')
  })
})

describe('verify --report: a malformed signature.json (V5)', () => {
  test('does not suppress the byte checks: tampered records AND a truncated signature exit 2', async () => {
    await writeExport({ sign: true })
    await writeFile(join(reportDir, REPORT_FILES.records), '{"not":"the exported records"}\n', 'utf8')
    await writeFile(join(reportDir, REPORT_FILES.signature), '{"formatVersion":1,', 'utf8')
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    // Before the fix: exit 1 with EMPTY stdout -- not one byte checked, and a
    // tamperer who corrupted two files scored lower than one who corrupted one.
    expect(exitCode).toBe(2)
    expect(io.out()).toContain('[FAIL]')
    expect(io.out()).toContain('records.jsonl digest')
  })

  test('a truncated signature alone is INCOMPLETE (exit 1) with every other check run', async () => {
    await writeExport({ sign: true })
    await writeFile(join(reportDir, REPORT_FILES.signature), '{"formatVersion":1,', 'utf8')
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    expect(exitCode).toBe(1)
    expect(io.out()).toContain('[NOT RUN] manifest signature')
    expect(io.out()).toMatch(/\[PASS\]\s+records\.jsonl digest/)
  })
})

describe('verify --report: a manifest naming a key with no signature file (V6)', () => {
  test('exits 2 instead of printing a clean UNSIGNED pass', async () => {
    await writeExport({ sign: true })
    await rm(join(reportDir, REPORT_FILES.signature))
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    expect(exitCode).toBe(2)
    expect(io.out()).toContain('no signature.json')
  })
})

describe('verify --report: bounded whole-file reads (V10)', () => {
  test('an oversized report.json is refused cleanly instead of being read whole', async () => {
    await writeExport()
    // 9 MiB of padding inside a legitimate manifest: past the command's own
    // ceiling, but nothing like the ~2 GB a hostile bundle would carry.
    const path = join(reportDir, REPORT_FILES.manifest)
    const raw = await readFile(path, 'utf8')
    await writeFile(path, raw.replace('{\n', `{\n  "padding": "${'x'.repeat(9 * 1024 * 1024)}",\n`), 'utf8')
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('limit')
  })
})

describe('verify --report --require-signature (V11)', () => {
  test('an UNSIGNED export exits 2 instead of 0', async () => {
    await writeExport()
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir, '--require-signature'], io)

    expect(exitCode).toBe(2)
    expect(io.out()).toContain('--require-signature')
  })

  test('the same export without the flag still exits 0 -- default behaviour is unchanged', async () => {
    await writeExport()

    expect(await run(['--report', reportDir])).toBe(0)
  })

  test('a properly signed export still exits 0 with the flag', async () => {
    await writeExport({ sign: true })

    expect(await run(['--report', reportDir, '--require-signature'])).toBe(0)
  })

  test('a signed export whose key is unavailable exits 2 with the flag, 1 without', async () => {
    const keyHome = await mkdtemp(join(tmpdir(), 'mcpcut-key-far-'))
    try {
      await writeExport({ sign: true, keyDir: keyHome })

      expect(await run(['--report', reportDir])).toBe(1)
      expect(await run(['--report', reportDir, '--require-signature'])).toBe(2)
    } finally {
      await rm(keyHome, { recursive: true, force: true })
    }
  })

  test('is rejected outside --report rather than silently doing nothing', async () => {
    const io = fakeIo()

    const exitCode = await run(['--require-signature'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('--require-signature')
  })
})

describe('verify --report: summary.md is attested (V12)', () => {
  test('a deleted summary.md exits 2', async () => {
    await writeExport()
    await rm(join(reportDir, REPORT_FILES.summary))
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    expect(exitCode).toBe(2)
    expect(io.out()).toContain('summary.md')
  })

  test('an edited summary.md exits 2', async () => {
    await writeExport({ sign: true })
    const path = join(reportDir, REPORT_FILES.summary)
    await writeFile(path, `${await readFile(path, 'utf8')}\nEverything here was approved.\n`, 'utf8')
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir], io)

    expect(exitCode).toBe(2)
    expect(io.out()).toContain('summary.md digest')
  })
})

describe('verify --report: argument errors print usage (V13)', () => {
  test('--report with no value prints usage and exits 1 instead of throwing', async () => {
    const io = fakeIo()

    const exitCode = await run(['--report'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage: mcpcut verify')
  })

  test('an unknown flag prints usage and exits 1', async () => {
    const io = fakeIo()

    const exitCode = await run(['--report', reportDir, '--not-a-flag'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage: mcpcut verify')
  })
})

describe('verify --report: the printed check list', () => {
  test('names every check an auditor is entitled to see, including the ones that did not apply', async () => {
    await writeExport({ sign: true })
    const io = fakeIo()

    await run(['--report', reportDir], io)

    for (const label of [
      'records.jsonl digest',
      'records.jsonl line count',
      'summary.md digest',
      'manifest self-consistency',
      'claims recomputed from records.jsonl',
      'chain re-fold',
      'manifest signature',
    ]) {
      expect(io.out()).toContain(label)
    }
    expect(io.out()).toContain('NOT re-derived: seqRange')
  })
})

/**
 * ADR-0015 phase 5 (O1): the pool binding lives in `summary.md` only. A signed
 * export of a journal holding a pool session and its children is still format
 * v1, carries exactly the manifest keys it always did, and passes every
 * offline check -- through the real `keygen` -> `export --report` -> `verify
 * --report --pub` path an operator and an auditor take.
 */
describe('verify --report: an export holding a pool session', () => {
  async function journalThrough(sessionId: string, records: readonly JournalRecord[]): Promise<void> {
    const sink = createJournalSink(sessionId, { dir: journalDir })
    for (const record of records) sink.write(record)
    await sink.close()
  }

  function request(sessionId: string, id: string): JournalRecord {
    return { id, ts: new Date().toISOString(), sessionId, direction: 'client→server', kind: 'request', method: 'tools/call', payload: {} }
  }

  async function exportTo(dir: string): Promise<ReportManifest> {
    expect(await runExportCommand(['--report', '--out', dir], fakeIo(), { journalDir })).toBe(0)
    return JSON.parse(await readFile(join(dir, REPORT_FILES.manifest), 'utf8')) as ReportManifest
  }

  test('stays format v1 with the same manifest keys and passes all seven checks', async () => {
    expect(await runKeygenCommand([], fakeIo(), { journalDir })).toBe(0)
    await journalThrough('plain-1', [request('plain-1', '01AAAAAAAAAAAAAAAAAAAAAAA0')])
    const plainDir = join(reportDir, 'plain')
    const plainKeys = Object.keys(await exportTo(plainDir)).sort()

    await journalThrough('pool-p', [
      buildPoolRecord({ sessionId: 'pool-p', pool: { agentName: 'bot', event: 'open', members: ['alpha'] } }),
      buildPoolRecord({
        sessionId: 'pool-p',
        pool: { agentName: 'bot', event: 'attach', serverName: 'alpha', childSessionId: 'child-1' },
      }),
      buildPoolRecord({ sessionId: 'pool-p', pool: { agentName: 'bot', event: 'close' } }),
    ])
    await journalThrough('child-1', [request('child-1', '01AAAAAAAAAAAAAAAAAAAAAAA1')])
    const poolDir = join(reportDir, 'pool')
    const manifest = await exportTo(poolDir)
    const io = fakeIo()

    const exitCode = await run(['--report', poolDir, '--pub', join(journalDir, 'signing.pub')], io)

    expect(manifest.formatVersion).toBe(1)
    expect(Object.keys(manifest).sort()).toEqual(plainKeys)
    expect(await readFile(join(poolDir, REPORT_FILES.summary), 'utf8')).toContain('### Pool session pool-p')
    expect(exitCode).toBe(0)
    expect(io.out().match(/\[PASS\]/g)).toHaveLength(7)
    expect(io.out()).not.toContain('[FAIL]')
    expect(io.out()).toContain('RESULT: PASSED')
  })
})
