import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR, ADMINS_FILE_NAME } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { POLICY_EDIT_SESSION_ID } from '../../src/journal/policy-edit-record.js'
import { runPolicySet, type PolicySetOptions } from '../../src/cli/policy-set-cmd.js'
import { readJournalRecords } from '../support/journal-rows.js'

/**
 * Owner decision 2026-09-25 (first-minute friction): `policy set` on an
 * install with NO admin yet needs no owner token — the first `admin add` there
 * is token-free anyway (ADR-0004), so the gate kept nobody out and only cost a
 * step. The edit is journaled as `policy-edit` with `adminName: null` and
 * `role: null`, the shape `access-edit` already uses for nobody named.
 */

let journalDir: string
let workDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-policy-set-no-admins-'))
  workDir = await mkdtemp(join(tmpdir(), 'mcpcut-policy-set-no-admins-cwd-'))
  await writeFile(join(journalDir, 'policy.json'), JSON.stringify({ version: 1 }), 'utf8')
  // An install that has run: its state.db exists. `listAdmins` on it is what
  // `admin list` would do first on a fresh install.
  await createAdminStore({ journalDir }).listAdmins()
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
})

function fakeIo(): { stdout: { write: (chunk: string) => void }; stderr: { write: (chunk: string) => void }; out: () => string; err: () => string } {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

function opts(env: NodeJS.ProcessEnv = {}): PolicySetOptions {
  return { journalDir, cwd: workDir, env }
}

async function policyDocument(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(journalDir, 'policy.json'), 'utf8')) as Record<string, unknown>
}

describe('policy set on an install with no admins yet', () => {
  test('writes the rule without a token and journals it with nobody named', async () => {
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'deny'], io, opts())

    expect(code).toBe(0)
    expect(await policyDocument()).toMatchObject({ servers: { github: { tools: { create_issue: 'deny' } } } })
    const records = await readJournalRecords(journalDir, POLICY_EDIT_SESSION_ID)
    expect(records).toHaveLength(1)
    expect((records[0]?.payload as { actor: unknown }).actor).toEqual({ adminName: null, role: null, via: 'cli' })
    expect(io.err()).toContain('no admins yet')
    expect(io.err()).toContain('[audit] policy set by unattributed: github/create_issue = deny')
  })

  test('once an admin exists, no token is a refusal again and the file is untouched', async () => {
    await createAdminStore({ journalDir }).createAdmin('me', 'owner')
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'deny'], io, opts())

    expect(code).toBe(1)
    expect(io.err()).toContain(ADMIN_TOKEN_ENV_VAR)
    expect(await policyDocument()).toEqual({ version: 1 })
    expect(await readJournalRecords(journalDir, POLICY_EDIT_SESSION_ID)).toEqual([])
  })

  test('a token that IS set is still checked: on an empty store it is refused', async () => {
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'deny'], io, opts({ [ADMIN_TOKEN_ENV_VAR]: 'mcpa_stale' }))

    expect(code).toBe(1)
    expect(await policyDocument()).toEqual({ version: 1 })
  })

  test('an admin store that cannot be read refuses, never edits unattributed', async () => {
    await writeFile(join(journalDir, ADMINS_FILE_NAME), '{ not json', 'utf8')
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'deny'], io, opts())

    expect(code).toBe(1)
    expect(io.err()).not.toContain('no admins yet')
    expect(await policyDocument()).toEqual({ version: 1 })
  })

  test('a data directory with no state.db is not a fresh install: a policy file elsewhere stays untouched', async () => {
    // A cron job without MCPCUT_DATA_DIR resolves an empty directory, while
    // MCPCUT_POLICY still names the real policy file (security review H1).
    const elsewhere = await mkdtemp(join(tmpdir(), 'mcpcut-policy-set-elsewhere-'))
    const io = fakeIo()

    try {
      const code = await runPolicySet(['github', 'create_issue', 'deny'], io, {
        journalDir: elsewhere,
        cwd: workDir,
        env: { MCPCUT_POLICY: join(journalDir, 'policy.json') },
      })

      expect(code).toBe(1)
      expect(io.err()).not.toContain('no admins yet')
      expect(await policyDocument()).toEqual({ version: 1 })
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })
})
