import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import type { DispatchOptions } from '../../src/cli.js'
import { POLICY_EDIT_SESSION_ID } from '../../src/journal/policy-edit-record.js'
import { loadPolicy } from '../../src/policy/load.js'
import { readJournalRecords } from '../support/journal-rows.js'
import { createPlane, type Plane } from './m3-harness.js'

/**
 * `policy set` end to end through `dispatch()` over one temp journal
 * directory (policy-tool-rules-ui plan, wave 5 gate): `admin add` mints the
 * owner token → `policy set` writes the rule → the file is still minimal and
 * loads → `policy show` reflects it and states the reload split → the
 * journal holds one attributed `policy-edit` record. The per-branch
 * behaviour lives in `tests/cli/policy-set-cmd.test.ts`; this file shows the
 * composition only.
 */

let tempDir: string
let plane: Plane

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-policy-set-e2e-'))
  plane = createPlane(tempDir)
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

/** The `policy` seam: pinned to the temp dir so the repository's own policy is never discovered. */
function policySeam(token?: string): DispatchOptions {
  return {
    policy: {
      cwd: tempDir,
      journalDir: tempDir,
      env: token === undefined ? {} : { [ADMIN_TOKEN_ENV_VAR]: token },
    },
  }
}

async function mintAdminToken(name: string, role: string): Promise<string> {
  const run = await plane.run(['admin', 'add', name, '--role', role])
  expect(run.code).toBe(0)
  const token = /^token: (\S+)$/m.exec(run.out)?.[1]
  if (token === undefined) throw new Error(`admin add printed no token: ${run.out}`)
  return token
}

describe('policy set (e2e)', () => {
  test('owner sets a rule; the file stays minimal and loadable; policy show and the journal reflect it', async () => {
    const policyPath = join(tempDir, 'policy.json')
    await writeFile(policyPath, '{"version": 1}\n', 'utf8')
    const token = await mintAdminToken('alice', 'owner')

    const set = await plane.run(['policy', 'set', 'github', 'delete_repo', 'deny'], policySeam(token))

    expect(set.err, set.err).toMatch(/^\[audit\] policy set by alice \(owner\): github\/delete_repo = deny/m)
    expect(set.code).toBe(0)
    expect(set.out).toMatch(/^policy [0-9a-f]{8} -> [0-9a-f]{8}: github\/delete_repo = deny; effective now: deny \(explicit\)$/m)
    expect(set.out).toContain('without restart')

    // The written file: the operator's minimal document plus exactly one rule.
    expect(JSON.parse(await readFile(policyPath, 'utf8'))).toEqual({
      version: 1,
      servers: { github: { tools: { delete_repo: 'deny' } } },
    })
    const loaded = await loadPolicy({ explicitPath: policyPath })
    expect(loaded.status).toBe('loaded')

    // `policy show` sees the rule and states the reload split.
    const show = await plane.run(['policy', 'show', '--server', 'github'], policySeam())
    expect(show.code).toBe(0)
    expect(show.out).toContain('delete_repo: deny')
    expect(show.out).toMatch(/^hot reload: rules yes .* wiring config no/m)

    // One attributed record under the reserved session.
    const records = await readJournalRecords(tempDir, POLICY_EDIT_SESSION_ID)
    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe('policy-edit')
    expect(records[0]?.payload).toMatchObject({
      actor: { adminName: 'alice', role: 'owner', via: 'cli' },
      serverName: 'github',
      toolName: 'delete_repo',
      rule: 'deny',
      sourcePath: policyPath,
    })
  })

  test('clear removes the rule again and policy show no longer lists it', async () => {
    const policyPath = join(tempDir, 'policy.json')
    await writeFile(policyPath, JSON.stringify({ version: 1, servers: { github: { tools: { delete_repo: 'deny' } } } }), 'utf8')
    const token = await mintAdminToken('alice', 'owner')

    const cleared = await plane.run(['policy', 'set', 'github', 'delete_repo', 'clear'], policySeam(token))

    expect(cleared.code).toBe(0)
    expect(cleared.out).toMatch(/github\/delete_repo = cleared; effective now: \S+ \(global-default\)/)
    // An emptied `tools` map, and the server entry it emptied, are pruned: the file does not grow rubble.
    expect(JSON.parse(await readFile(policyPath, 'utf8'))).toEqual({ version: 1 })
    const show = await plane.run(['policy', 'show', '--server', 'github'], policySeam())
    expect(show.out).not.toContain('delete_repo')
    const records = await readJournalRecords(tempDir, POLICY_EDIT_SESSION_ID)
    expect(records.map((record) => (record.payload as { rule: unknown }).rule)).toEqual([null])
  })

  test('an operator token is refused through the dispatcher and nothing is written or journaled', async () => {
    const policyPath = join(tempDir, 'policy.json')
    await writeFile(policyPath, '{"version": 1}\n', 'utf8')
    const token = await mintAdminToken('bob', 'operator')

    const run = await plane.run(['policy', 'set', 'github', 'delete_repo', 'deny'], policySeam(token))

    expect(run.code).toBe(1)
    expect(run.err).toContain('role "owner"')
    expect(await readFile(policyPath, 'utf8')).toBe('{"version": 1}\n')
    expect(await readJournalRecords(tempDir, POLICY_EDIT_SESSION_ID)).toEqual([])
  })
})
