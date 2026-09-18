import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { REDACTED_PLACEHOLDER } from '../../src/config.js'
import { createJournalSink } from '../../src/journal/sink.js'
import { createRecordBuilder } from '../../src/journal/record.js'
import { journalAccessEdit } from '../../src/groups/journal-access-edit.js'
import type { AccessEditInfo } from '../../src/journal/access-edit-record.js'
import { journalPolicyEdit } from '../../src/policy/edit/journal-edit.js'
import { journalProbe } from '../../src/probe/journal-probe.js'
import { classify } from '../../src/protocol/classify.js'
import { collectPersistedBytes } from '../support/persisted-bytes.js'

/**
 * Redaction sweep (M4.5 wave 4, ADR-0006, plan Task 8): proves the whole real
 * pipeline — `classify()` → `createRecordBuilder().buildRecord()` →
 * `createJournalSink().write()`/`flush()` — never lands a secret in
 * `journal.db`, mirroring PERSISTED_BYTES_SWEEP
 * (`tests/policy/approvals/queue.test.ts`, `tests/e2e/m3-integration.test.ts`):
 * a positive sentinel (the store file was actually reached) before the
 * negative assertion (the secret is absent from either byte rendering), so
 * the check can never pass vacuously.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-redaction-sweep-test-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

/** Distinctive enough to grep for; the key name alone is what triggers redaction. */
const SECRET_VALUE = 'sk-live-sweepsecret123'

describe('journal redaction sweep: a secret never reaches journal.db', () => {
  test('a record built through classify()+buildRecord() is redacted before persistence', async () => {
    const rawLine = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_issue', arguments: { title: 'hello', apiKey: SECRET_VALUE } },
    })

    const record = createRecordBuilder('session-sweep').buildRecord(classify(rawLine), 'client→server')

    // Sanity: the record itself is already clean before it ever reaches storage.
    expect(JSON.stringify(record)).not.toContain(SECRET_VALUE)
    expect(JSON.stringify(record)).toContain(REDACTED_PLACEHOLDER)

    const sink = createJournalSink('session-sweep', { dir: journalDir })
    sink.write(record)
    await sink.flush()

    const { fileNames, renderings } = await collectPersistedBytes(journalDir)
    // Positive sentinel first: the sweep actually reached the store.
    expect(fileNames).toContain('journal.db')
    // `synchronous=FULL` under WAL still checkpoints lazily, so a committed
    // record may live only in the -wal sidecar until that happens — assert
    // its presence rather than assuming it, since collectPersistedBytes only
    // reports what actually exists on disk right now.
    if (fileNames.some((name) => name.endsWith('-wal'))) {
      expect(fileNames).toContain('journal.db-wal')
    }

    for (const rendering of renderings) {
      expect(rendering).not.toContain(SECRET_VALUE)
    }
    expect(renderings.some((rendering) => rendering.includes(REDACTED_PLACEHOLDER))).toBe(true)
  })

  test('the probe path — journalProbe() — never lands a secret in journal.db (M5.5 Task 5)', async () => {
    // The probe engine already writes redacted messages; this pins the
    // journal-side guarantee anyway: redaction is the ONLY path into the
    // journal, probe records included, so even an error string that arrives
    // carrying a bearer token must be scrubbed before persistence.
    const outcome = await journalProbe({
      serverName: 'github-live',
      initiator: { trigger: 'refresh', adminName: 'alice' },
      result: {
        status: 'error',
        message: `the server echoed Bearer ${SECRET_VALUE} in its failure body`,
      },
      dir: journalDir,
    })
    expect(outcome.written).toBe(true)

    const { fileNames, renderings } = await collectPersistedBytes(journalDir)
    // Positive sentinel first: the sweep actually reached the store.
    expect(fileNames).toContain('journal.db')

    for (const rendering of renderings) {
      expect(rendering).not.toContain(SECRET_VALUE)
    }
    expect(renderings.some((rendering) => rendering.includes(REDACTED_PLACEHOLDER))).toBe(true)
  })

  test('the policy-edit path — journalPolicyEdit() — never lands a secret in journal.db (audit 2026-09-02, F2)', async () => {
    // `sourcePath` is the one free-text field on this kind: whatever path the
    // write target resolved to, never validated as a name, so it is where a
    // stray secret would ride into the payload. The builder redacts the whole
    // payload; this pins that the redacted bytes are what reach the store,
    // exactly as the traffic and probe sweeps above do for their kinds.
    const outcome = await journalPolicyEdit({
      edit: {
        actor: { adminName: 'alice', role: 'owner', via: 'ui' },
        serverName: 'github',
        toolName: 'create_issue',
        rule: 'deny',
        policyHashBefore: null,
        policyHashAfter: 'a'.repeat(64),
        sourcePath: `/srv/journal/${SECRET_VALUE}/policy.json`,
      },
      dir: journalDir,
    })
    expect(outcome.written).toBe(true)

    const { fileNames, renderings } = await collectPersistedBytes(journalDir)
    // Positive sentinel first: the sweep actually reached the store.
    expect(fileNames).toContain('journal.db')

    for (const rendering of renderings) {
      expect(rendering).not.toContain(SECRET_VALUE)
    }
    expect(renderings.some((rendering) => rendering.includes(REDACTED_PLACEHOLDER))).toBe(true)
  })

  test('the access-edit path — journalAccessEdit() — never lands a secret in journal.db (audit 2026-09-02, F2)', async () => {
    // This kind has NO free-text field: every string is a group, server,
    // agent or admin name, validated at the CLI/UI boundary before the
    // builder sees it. The builder itself accepts any string, though, and it
    // — not the boundary — is the journal's redaction choke point, so the
    // secret goes into `agent` to pin the journal-side guarantee
    // independently of whatever upstream validation happens to hold.
    const outcome = await journalAccessEdit({
      info: {
        actor: { adminName: 'alice', role: 'owner', via: 'cli' },
        action: 'group.join',
        group: 'research',
        agent: SECRET_VALUE,
      },
      dir: journalDir,
    })
    expect(outcome.written).toBe(true)

    const { fileNames, renderings } = await collectPersistedBytes(journalDir)
    // Positive sentinel first: the sweep actually reached the store.
    expect(fileNames).toContain('journal.db')

    for (const rendering of renderings) {
      expect(rendering).not.toContain(SECRET_VALUE)
    }
    expect(renderings.some((rendering) => rendering.includes(REDACTED_PLACEHOLDER))).toBe(true)
  })

  test('the vault path — a vault.set record through journalAccessEdit() — never lands the value, even in a stray field (S2, 2026-09-03)', async () => {
    // `vault.set` names the SECRET, never its value: the record has no field
    // for one and must not grow one. The builder assembles the payload field
    // by field, so a value a careless caller attaches under any other key is
    // dropped before redaction even runs. Pinned through the real writer so
    // the guarantee is about the bytes in journal.db, not the type.
    const stray = {
      actor: { adminName: 'alice', role: 'owner', via: 'cli' },
      action: 'vault.set',
      vaultEntry: 'github-pat',
      value: SECRET_VALUE,
      token: SECRET_VALUE,
    }
    const outcome = await journalAccessEdit({ info: stray as AccessEditInfo, dir: journalDir })
    expect(outcome.written).toBe(true)

    const { fileNames, renderings } = await collectPersistedBytes(journalDir)
    // Positive sentinels first: the sweep reached the store AND the record
    // itself landed there (its secret NAME is what should be on disk).
    expect(fileNames).toContain('journal.db')
    expect(renderings.some((rendering) => rendering.includes('"action":"vault.set"'))).toBe(true)
    expect(renderings.some((rendering) => rendering.includes('github-pat'))).toBe(true)

    for (const rendering of renderings) {
      expect(rendering).not.toContain(SECRET_VALUE)
    }
  })
})
