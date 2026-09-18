import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  insertRecordRows,
  journalDbPathFor,
  openJournalDbShared,
  type JournalRecordRow,
} from '../../src/journal/db.js'
import { buildJournalReport, type ReportManifest } from '../../src/journal/report.js'
import { parseReportManifestJson, parseReportSignatureJson } from '../../src/journal/report-parse.js'
import { signReportManifest } from '../../src/journal/report-signing.js'
import {
  generateAndWriteSigningKeyPair,
  loadSigningPrivateKey,
} from '../../src/journal/signing.js'

/**
 * `src/journal/report-parse.ts` (M5 wave 5, task 5.3): an export directory is
 * fully untrusted input -- it arrives on an auditor's laptop from somewhere
 * else entirely -- so every field is validated with zod before any check
 * logic can see it. These tests assert the two things that matter for that:
 * a manifest the REAL exporter produced round-trips, and every malformed
 * shape is rejected with a message that NAMES the offending field (an
 * auditor who cannot tell which field is wrong cannot ask the right
 * question of whoever handed them the report).
 */

const AS_OF = '2026-08-18T12:00:00.000Z'

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-report-parse-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function rowOf(doc: string): JournalRecordRow {
  return {
    sessionId: 'session-1',
    recordId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: '2026-08-18T00:00:00.000Z',
    direction: 'client→server',
    kind: 'notification',
    method: 'tools/list',
    doc,
  }
}

async function realManifest(): Promise<ReportManifest> {
  const handle = await openJournalDbShared(journalDbPathFor(journalDir))
  handle.transaction((db) => insertRecordRows(db, [rowOf(JSON.stringify({ hello: 'world' }))]))
  const report = await buildJournalReport(handle, { asOf: AS_OF }, { writeLine: () => undefined })
  return report.manifest
}

/** Serializes, re-parses to a plain object, mutates that copy, re-serializes: exactly how a tamperer edits a file on disk. */
function withEdit(manifest: ReportManifest, edit: (raw: Record<string, unknown>) => void): string {
  const raw = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>
  edit(raw)
  return JSON.stringify(raw, null, 2)
}

function errorsOf(result: ReturnType<typeof parseReportManifestJson>): readonly string[] {
  if (result.ok) throw new Error('expected the parse to fail, but it succeeded')
  return result.errors
}

describe('parseReportManifestJson: a real exported manifest', () => {
  test('round-trips every field the exporter wrote', async () => {
    const manifest = await realManifest()

    const result = parseReportManifestJson(JSON.stringify(manifest, null, 2))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(manifest)
  })

  test('accepts the genesis empty-string startPrevHash as a VALUE, not an absent field', async () => {
    const manifest = await realManifest()
    expect(manifest.chain.startPrevHash).toBe('')

    const result = parseReportManifestJson(JSON.stringify(manifest))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.chain.startPrevHash).toBe('')
  })
})

describe('parseReportManifestJson: not a manifest at all', () => {
  test('rejects text that is not JSON', () => {
    const errors = errorsOf(parseReportManifestJson('{not json'))

    expect(errors.join(' ')).toContain('JSON')
  })

  test('rejects a JSON value that is not an object', () => {
    const errors = errorsOf(parseReportManifestJson('[]'))

    expect(errors.length).toBeGreaterThan(0)
  })
})

describe('parseReportManifestJson: formatVersion', () => {
  test('an absent formatVersion is rejected by name', async () => {
    const manifest = await realManifest()
    const text = withEdit(manifest, (raw) => {
      delete raw['formatVersion']
    })

    const errors = errorsOf(parseReportManifestJson(text))

    expect(errors.join(' ')).toContain('formatVersion')
  })

  test('an unsupported formatVersion is rejected by name, reporting what was found', async () => {
    const manifest = await realManifest()
    const text = withEdit(manifest, (raw) => {
      raw['formatVersion'] = 2
    })

    const errors = errorsOf(parseReportManifestJson(text))

    expect(errors.join(' ')).toContain('formatVersion')
    expect(errors.join(' ')).toContain('2')
  })
})

describe('parseReportManifestJson: malformed fields', () => {
  test('a missing required field is named by its full path', async () => {
    const manifest = await realManifest()
    const text = withEdit(manifest, (raw) => {
      delete (raw['records'] as Record<string, unknown>)['sha256']
    })

    const errors = errorsOf(parseReportManifestJson(text))

    expect(errors.join(' ')).toContain('records.sha256')
  })

  test('a wrong-typed field is named by its full path', async () => {
    const manifest = await realManifest()
    const text = withEdit(manifest, (raw) => {
      ;(raw['records'] as Record<string, unknown>)['lineCount'] = 'seven'
    })

    const errors = errorsOf(parseReportManifestJson(text))

    expect(errors.join(' ')).toContain('records.lineCount')
  })

  test('an unknown key is rejected rather than silently stripped', async () => {
    const manifest = await realManifest()
    const text = withEdit(manifest, (raw) => {
      raw['extra'] = 'smuggled'
    })

    const errors = errorsOf(parseReportManifestJson(text))

    expect(errors.join(' ')).toContain('extra')
  })

  test('a non-hex records.sha256 is rejected', async () => {
    const manifest = await realManifest()
    const text = withEdit(manifest, (raw) => {
      ;(raw['records'] as Record<string, unknown>)['sha256'] = 'nope'
    })

    const errors = errorsOf(parseReportManifestJson(text))

    expect(errors.join(' ')).toContain('records.sha256')
  })

  test('chain.recomputable without chain.startPrevHash is rejected by name', async () => {
    const manifest = await realManifest()
    const text = withEdit(manifest, (raw) => {
      delete (raw['chain'] as Record<string, unknown>)['startPrevHash']
    })

    const errors = errorsOf(parseReportManifestJson(text))

    expect(errors.join(' ')).toContain('chain.startPrevHash')
  })
})

describe('parseReportSignatureJson', () => {
  async function realSignatureText(): Promise<string> {
    const manifest = await realManifest()
    await generateAndWriteSigningKeyPair(journalDir)
    const lookup = await loadSigningPrivateKey(journalDir)
    if (!lookup.present) throw new Error('fixture keygen wrote no private key')
    return JSON.stringify(signReportManifest(lookup.privateKeyPem, manifest).signature, null, 2)
  }

  test('round-trips a real signature file', async () => {
    const text = await realSignatureText()

    const result = parseReportSignatureJson(text)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.algorithm).toBe('ed25519')
  })

  test('rejects an unsupported signature formatVersion by name', async () => {
    const raw = JSON.parse(await realSignatureText()) as Record<string, unknown>
    raw['formatVersion'] = 99

    const result = parseReportSignatureJson(JSON.stringify(raw))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toContain('formatVersion')
  })

  test('rejects an algorithm this verifier cannot check', async () => {
    const raw = JSON.parse(await realSignatureText()) as Record<string, unknown>
    raw['algorithm'] = 'rsa'

    const result = parseReportSignatureJson(JSON.stringify(raw))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toContain('algorithm')
  })

  test('rejects a missing signatureBase64 by name', async () => {
    const raw = JSON.parse(await realSignatureText()) as Record<string, unknown>
    delete raw['signatureBase64']

    const result = parseReportSignatureJson(JSON.stringify(raw))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toContain('signatureBase64')
  })
})

/**
 * `__proto__` (M5 wave-5 review, finding V1 -- CRITICAL). Zod does NOT see
 * `__proto__` as an unknown key: `z.strictObject` silently drops it, the
 * manifest is rebuilt without it, and `canonicalJson` then signs bytes that
 * are not the file's bytes. Every non-JS consumer (jq, python, Go, a human,
 * a GRC pipeline) reads the injected content as part of the manifest, and
 * only this verifier is blind to it -- exactly the wrong way round. So the
 * key is refused at the JSON boundary, before zod ever sees the value.
 */
describe('parseReportManifestJson: a smuggled __proto__ key', () => {
  test('rejects a manifest carrying __proto__ at the top level', async () => {
    const manifest = await realManifest()
    const text = JSON.stringify(manifest, null, 2).replace(
      '{\n',
      '{\n  "__proto__": {"auditorNote": "scope excludes sessions under legal hold"},\n',
    )

    const result = parseReportManifestJson(text)

    expect(result.ok).toBe(false)
    expect(errorsOf(result).join(' ')).toContain('__proto__')
  })

  test('rejects a __proto__ smuggled into a NESTED object, where the signature is just as blind', async () => {
    const manifest = await realManifest()
    const text = JSON.stringify(manifest, null, 2).replace(
      '"records": {',
      '"records": {\n    "__proto__": {"note": "these are not the bytes you are looking for"},',
    )

    const result = parseReportManifestJson(text)

    expect(result.ok).toBe(false)
    expect(errorsOf(result).join(' ')).toContain('__proto__')
  })

  test('rejects a __proto__ inside signature.json too', () => {
    const text = JSON.stringify({
      formatVersion: 1,
      algorithm: 'ed25519',
      keyFingerprint: 'a'.repeat(64),
      signatureBase64: 'AAAA',
    }).replace('{', '{"__proto__":{"x":1},')

    const result = parseReportSignatureJson(text)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toContain('__proto__')
  })

  test('leaves an ordinary manifest untouched -- the guard is about one key, not about strictness in general', async () => {
    const manifest = await realManifest()

    const result = parseReportManifestJson(JSON.stringify(manifest, null, 2))

    expect(result.ok).toBe(true)
  })
})

/**
 * Session ids the exporter can legitimately emit (finding V9). `sessionIds`
 * comes straight from the `session_id` COLUMN, and `textOf` yields `''` for
 * a non-TEXT value; a `.min(1)` schema turned one odd row into a wholesale
 * rejection of the report -- exit 1, so the digest, count and signature
 * checks never ran and the real discrepancy never surfaced as a finding.
 * Malformed-looking evidence must not suppress the checks that still apply.
 */
describe('parseReportManifestJson: an empty session id', () => {
  test('accepts an empty-string session id rather than refusing the whole report', async () => {
    const manifest = await realManifest()
    const text = withEdit(manifest, (raw) => {
      raw['sessionIds'] = ['', 'session-1']
    })

    const result = parseReportManifestJson(text)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.sessionIds).toEqual(['', 'session-1'])
  })
})

/**
 * The summary digest (amendment A1). `summary.md` is the only artifact a
 * non-technical reader consumes and it was outside every integrity
 * mechanism, so v1 now carries its digest; a manifest without it is not a v1
 * manifest.
 */
describe('parseReportManifestJson: the summary digest', () => {
  test('the real exporter stamps summary.file and summary.sha256', async () => {
    const manifest = await realManifest()

    expect(manifest.summary.file).toBe('summary.md')
    expect(manifest.summary.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('rejects a manifest with no summary block, naming the field', async () => {
    const manifest = await realManifest()
    const text = withEdit(manifest, (raw) => {
      delete raw['summary']
    })

    const result = parseReportManifestJson(text)

    expect(result.ok).toBe(false)
    expect(errorsOf(result).join(' ')).toContain('summary')
  })
})
