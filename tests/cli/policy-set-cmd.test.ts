import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR, type AdminRole } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { POLICY_EDIT_SESSION_ID } from '../../src/journal/policy-edit-record.js'
import { runPolicyShow } from '../../src/cli/policy-cmd.js'
import { POLICY_SET_MIN_ROLE, runPolicySet, type PolicySetOptions } from '../../src/cli/policy-set-cmd.js'
import { defaultPolicyFileDeps, type PolicyFileDeps } from '../../src/policy/edit/policy-file.js'
import { loadPolicy } from '../../src/policy/load.js'
import { policyHashOf } from '../../src/policy/provenance.js'
import { readJournalRecords } from '../support/journal-rows.js'

/**
 * `policy set` (policy-tool-rules-ui plan, wave 5; ADR-0009 §6): the CLI
 * parity of the Servers-card rule buttons. Every branch is driven through
 * `runPolicySet` with injected io, a temp journal directory and — for the
 * two branches a real filesystem cannot produce on demand (a concurrent
 * write, a failed write) — injected file deps.
 */

let journalDir: string
/**
 * The shell's cwd, deliberately NOT the state directory: since 2026-08-26 the
 * command edits the file it would itself load, so cwd decides the
 * project-level candidate. Leaving it at `process.cwd()` would aim the tests
 * at the repository's own `.mcp-journal/policy.json`.
 */
let workDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-policy-set-'))
  workDir = await mkdtemp(join(tmpdir(), 'mcp-journal-policy-set-cwd-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
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

const MINIMAL_POLICY = { version: 1 }

const RULED_POLICY = {
  version: 1,
  defaultDecision: 'require-approval',
  servers: { github: { tools: { 'delete_*': 'deny', list_issues: 'allow' } } },
}

function policyPath(): string {
  return join(journalDir, 'policy.json')
}

async function writePolicy(content: unknown): Promise<string> {
  await writeFile(policyPath(), JSON.stringify(content), 'utf8')
  return policyPath()
}

async function readPolicyDocument(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(policyPath(), 'utf8')) as Record<string, unknown>
}

/** Mints an admin through the production store and returns options carrying its token. */
async function optsForAdmin(name: string, role: AdminRole): Promise<PolicySetOptions> {
  const { token } = await createAdminStore({ journalDir }).createAdmin(name, role)
  return { journalDir, cwd: workDir, env: { [ADMIN_TOKEN_ENV_VAR]: token } }
}

async function ownerOpts(): Promise<PolicySetOptions> {
  return optsForAdmin('alice', 'owner')
}

/** Every `policy-edit` record written under the reserved session, oldest first. */
async function editRecords(): Promise<Array<Record<string, unknown>>> {
  const records = await readJournalRecords(journalDir, POLICY_EDIT_SESSION_ID)
  return records.map((record) => record.payload as Record<string, unknown>)
}

describe('runPolicySet -- admin attribution', () => {
  test('refuses without a token: hint names the env var and the owner role, exit 1, file untouched', async () => {
    await writePolicy(MINIMAL_POLICY)
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'deny'], io, { journalDir, cwd: workDir, env: {} })

    expect(code).toBe(1)
    expect(io.err()).toContain(ADMIN_TOKEN_ENV_VAR)
    expect(io.err()).toContain(`role "${POLICY_SET_MIN_ROLE}"`)
    expect(await readPolicyDocument()).toEqual(MINIMAL_POLICY)
    expect(await editRecords()).toEqual([])
  })

  test('refuses an unknown token, exit 1', async () => {
    await writePolicy(MINIMAL_POLICY)
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'deny'], io, {
      journalDir,
      cwd: workDir,
      env: { [ADMIN_TOKEN_ENV_VAR]: 'mcpa_nope' },
    })

    expect(code).toBe(1)
    expect(io.err()).toMatch(/does not match any active admin/)
    expect(await readPolicyDocument()).toEqual(MINIMAL_POLICY)
  })

  test.each(['operator', 'viewer'] as const)('refuses role %s: owner is required, exit 1', async (role) => {
    await writePolicy(MINIMAL_POLICY)
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'deny'], io, await optsForAdmin('bob', role))

    expect(code).toBe(1)
    expect(io.err()).toContain(`role "${POLICY_SET_MIN_ROLE}"`)
    expect(io.err()).toContain('mcp-journal admin role bob owner')
    expect(await readPolicyDocument()).toEqual(MINIMAL_POLICY)
    expect(await editRecords()).toEqual([])
  })

  test('POLICY_SET_MIN_ROLE is owner (the same row the UI applies to the rule route)', () => {
    expect(POLICY_SET_MIN_ROLE).toBe('owner')
  })
})

describe('runPolicySet -- arguments', () => {
  test('wrong positional count prints usage, exit 1', async () => {
    const io = fakeIo()

    const code = await runPolicySet(['github', 'deny'], io, await ownerOpts())

    expect(code).toBe(1)
    expect(io.err()).toContain('policy set <server> <tool>')
  })

  test('an unknown rule word is rejected with the accepted list, exit 1', async () => {
    await writePolicy(MINIMAL_POLICY)
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'block'], io, await ownerOpts())

    expect(code).toBe(1)
    expect(io.err()).toContain('allow, require-approval, deny, clear')
    expect(await readPolicyDocument()).toEqual(MINIMAL_POLICY)
  })

  test('an invalid server name is refused before the file is touched, exit 1', async () => {
    await writePolicy(MINIMAL_POLICY)
    const io = fakeIo()

    const code = await runPolicySet(['bad name', 'create_issue', 'deny'], io, await ownerOpts())

    expect(code).toBe(1)
    expect(io.err()).toMatch(/server name/i)
    expect(await readPolicyDocument()).toEqual(MINIMAL_POLICY)
  })

  test('a wildcard tool name is refused (per-tool rules are exact), exit 1', async () => {
    await writePolicy(MINIMAL_POLICY)
    const io = fakeIo()

    const code = await runPolicySet(['github', 'delete_*', 'deny'], io, await ownerOpts())

    expect(code).toBe(1)
    expect(io.err()).toMatch(/tool name/i)
    expect(await readPolicyDocument()).toEqual(MINIMAL_POLICY)
  })

  test('an unknown flag prints usage, exit 1', async () => {
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'deny', '--force'], io, await ownerOpts())

    expect(code).toBe(1)
    expect(io.err()).toContain('policy set <server> <tool>')
  })
})

describe('runPolicySet -- write target and file state', () => {
  /**
   * Correction 2026-08-26: a nested file `connect` reads first no longer
   * refuses the edit — the edit reaches `ui`/`wrap`/`serve`, which load the
   * file being written, and the command says so instead of blocking.
   */
  test('the nested connect-first file is stated, not refused: the state-dir file is still edited', async () => {
    await writePolicy(MINIMAL_POLICY)
    const nestedDir = join(journalDir, '.mcp-journal')
    await mkdir(nestedDir, { recursive: true })
    await writeFile(join(nestedDir, 'policy.json'), JSON.stringify(MINIMAL_POLICY), 'utf8')
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'deny'], io, await ownerOpts())

    expect(code).toBe(0)
    expect(io.out()).toContain(`file: ${policyPath()}`)
    expect(io.out()).toContain(`readers: connect reads ${join(nestedDir, 'policy.json')} first`)
    expect(await readPolicyDocument()).toEqual({ version: 1, servers: { github: { tools: { create_issue: 'deny' } } } })
    expect(await editRecords()).toHaveLength(1)
  })

  /**
   * The live install of 2026-08-26: the state dir holds no policy, the plane
   * enforces `<cwd>/.mcp-journal/policy.json`. The edit must land THERE, and
   * the command must say that `connect` sessions are not covered by it.
   */
  test('edits the project-level file this shell would load, and states that connect has no policy', async () => {
    const projectDir = join(workDir, '.mcp-journal')
    await mkdir(projectDir, { recursive: true })
    const projectPath = join(projectDir, 'policy.json')
    await writeFile(projectPath, JSON.stringify(MINIMAL_POLICY), 'utf8')
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'deny'], io, await ownerOpts())

    expect(code).toBe(0)
    expect(io.out()).toContain(`file: ${projectPath}`)
    expect(io.out()).toContain('readers: ui/wrap/serve read this file; connect sessions have no policy right now')
    expect(JSON.parse(await readFile(projectPath, 'utf8'))).toEqual({
      version: 1,
      servers: { github: { tools: { create_issue: 'deny' } } },
    })
    await expect(stat(policyPath())).rejects.toMatchObject({ code: 'ENOENT' })
    const records = await editRecords()
    expect(records).toHaveLength(1)
    expect(records[0]?.['sourcePath']).toBe(projectPath)
  })

  test('$MCP_JOURNAL_POLICY names the file to edit, as it names the file the entry point loads', async () => {
    const namedPath = join(workDir, 'named-policy.json')
    await writeFile(namedPath, JSON.stringify(MINIMAL_POLICY), 'utf8')
    const io = fakeIo()

    const opts = await ownerOpts()
    const code = await runPolicySet(['github', 'create_issue', 'deny'], io, {
      ...opts,
      env: { ...opts.env, MCP_JOURNAL_POLICY: namedPath },
    })

    expect(code).toBe(0)
    expect(io.out()).toContain(`file: ${namedPath}`)
    expect(JSON.parse(await readFile(namedPath, 'utf8'))).toEqual({
      version: 1,
      servers: { github: { tools: { create_issue: 'deny' } } },
    })
  })

  test('policy show --entry-point connect makes the same shadowing visible: source is the nested file', async () => {
    await writePolicy(RULED_POLICY)
    const nestedDir = join(journalDir, '.mcp-journal')
    await mkdir(nestedDir, { recursive: true })
    const nestedPath = join(nestedDir, 'policy.json')
    await writeFile(nestedPath, JSON.stringify(MINIMAL_POLICY), 'utf8')
    const io = fakeIo()

    const code = await runPolicyShow(['--entry-point', 'connect'], io, { cwd: journalDir, journalDir, env: {} })

    expect(code).toBe(0)
    expect(io.out()).toContain(`source: ${nestedPath}`)
    expect(io.out()).not.toContain(`source: ${policyPath()}`)
  })

  test('refuses when there is no policy file (O4): never creates one, exit 1', async () => {
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'deny'], io, await ownerOpts())

    expect(code).toBe(1)
    expect(io.err()).toContain(`no policy file at ${policyPath()}`)
    expect(io.err()).toContain('enforcement is off')
    expect(io.err()).toContain('create it by hand first')
    await expect(stat(policyPath())).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await editRecords()).toEqual([])
  })

  test('refuses an unloadable file, printing its errors with the path, exit 1', async () => {
    await writeFile(policyPath(), '{"version": 1, "defaultDecision": "maybe"}', 'utf8')
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'deny'], io, await ownerOpts())

    expect(code).toBe(1)
    expect(io.err()).toContain(policyPath())
    expect(io.err()).toContain('defaultDecision')
    expect(await editRecords()).toEqual([])
  })

  test('a concurrent change between read and write is a conflict with a re-run hint, exit 1', async () => {
    await writePolicy(MINIMAL_POLICY)
    let reads = 0
    const racingDeps: PolicyFileDeps = {
      ...defaultPolicyFileDeps,
      readFile: async (path) => {
        reads += 1
        // First read: what the command edits. Every later read (the CAS
        // re-read inside the write): someone else's version.
        return reads === 1 ? JSON.stringify(MINIMAL_POLICY) : JSON.stringify(RULED_POLICY)
      },
    }
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'deny'], io, {
      ...(await ownerOpts()),
      deps: { policyFile: racingDeps },
    })

    expect(code).toBe(1)
    expect(io.err()).toMatch(/changed on disk/)
    expect(io.err()).toContain('re-run')
    expect(await readPolicyDocument()).toEqual(MINIMAL_POLICY)
    expect(await editRecords()).toEqual([])
  })

  test('a failed atomic write is reported, exit 1, original intact', async () => {
    await writePolicy(MINIMAL_POLICY)
    const failingDeps: PolicyFileDeps = {
      ...defaultPolicyFileDeps,
      rename: async () => {
        throw new Error('EACCES: simulated')
      },
    }
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'deny'], io, {
      ...(await ownerOpts()),
      deps: { policyFile: failingDeps },
    })

    expect(code).toBe(1)
    expect(io.err()).toContain('EACCES')
    expect(await readPolicyDocument()).toEqual(MINIMAL_POLICY)
    expect(await editRecords()).toEqual([])
  })
})

describe('runPolicySet -- writing rules', () => {
  test.each(['allow', 'require-approval', 'deny'] as const)(
    'sets %s as an exact rule; the file stays minimal and loadable; stdout reports hashes and the effective outcome',
    async (rule) => {
      await writePolicy(MINIMAL_POLICY)
      const before = await loadPolicy({ explicitPath: policyPath() })
      if (before.status !== 'loaded') throw new Error('fixture policy did not load')
      const io = fakeIo()

      const code = await runPolicySet(['github', 'create_issue', rule], io, await ownerOpts())

      expect(code).toBe(0)
      expect(await readPolicyDocument()).toEqual({
        version: 1,
        servers: { github: { tools: { create_issue: rule } } },
      })
      const after = await loadPolicy({ explicitPath: policyPath() })
      if (after.status !== 'loaded') throw new Error(`written policy did not load: ${JSON.stringify(after)}`)
      const hashBefore = policyHashOf(before.policy).slice(0, 8)
      const hashAfter = policyHashOf(after.policy).slice(0, 8)
      expect(io.out()).toContain(
        `policy ${hashBefore} -> ${hashAfter}: github/create_issue = ${rule}; effective now: ${rule} (explicit)`,
      )
      expect(io.out()).toContain(`file: ${policyPath()}`)
      expect(io.out()).toContain('readers: every entry point reads this file')
      expect(io.out()).toContain('without restart')
    },
  )

  test('clear removes only the exact key, leaving a wildcard the operator wrote; outcome falls back to the wildcard', async () => {
    await writePolicy({
      version: 1,
      servers: { github: { tools: { 'delete_*': 'deny', delete_repo: 'allow' } } },
    })
    const io = fakeIo()

    const code = await runPolicySet(['github', 'delete_repo', 'clear'], io, await ownerOpts())

    expect(code).toBe(0)
    expect(await readPolicyDocument()).toEqual({
      version: 1,
      servers: { github: { tools: { 'delete_*': 'deny' } } },
    })
    expect(io.out()).toMatch(/github\/delete_repo = cleared; effective now: deny \(wildcard\)/)
  })

  test('clear on a tool with no explicit rule still succeeds and reports the default source', async () => {
    await writePolicy(MINIMAL_POLICY)
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'clear'], io, await ownerOpts())

    expect(code).toBe(0)
    expect(io.out()).toMatch(/github\/create_issue = cleared; effective now: \S+ \(global-default\)/)
  })

  test('other servers and keys are carried over untouched', async () => {
    await writePolicy(RULED_POLICY)
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'require-approval'], io, await ownerOpts())

    expect(code).toBe(0)
    expect(await readPolicyDocument()).toEqual({
      version: 1,
      defaultDecision: 'require-approval',
      servers: {
        github: { tools: { 'delete_*': 'deny', list_issues: 'allow', create_issue: 'require-approval' } },
      },
    })
  })

  test('--json prints the machine-readable shape with full hashes', async () => {
    await writePolicy(MINIMAL_POLICY)
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'deny', '--json'], io, await ownerOpts())

    expect(code).toBe(0)
    const after = await loadPolicy({ explicitPath: policyPath() })
    if (after.status !== 'loaded') throw new Error('written policy did not load')
    const parsed = JSON.parse(io.out()) as Record<string, unknown>
    expect(parsed).toEqual({
      server: 'github',
      tool: 'create_issue',
      rule: 'deny',
      hashBefore: expect.stringMatching(/^[0-9a-f]{64}$/),
      hashAfter: policyHashOf(after.policy),
      effective: { outcome: 'deny', source: 'explicit', rulePath: 'servers.github.tools.create_issue' },
      sourcePath: policyPath(),
      readers: { connect: true, connectPath: null, operator: true },
    })
    expect(parsed['hashBefore']).not.toBe(parsed['hashAfter'])
  })

  test('--json for clear carries rule: null', async () => {
    await writePolicy(RULED_POLICY)
    const io = fakeIo()

    const code = await runPolicySet(['github', 'list_issues', 'clear', '--json'], io, await ownerOpts())

    expect(code).toBe(0)
    const parsed = JSON.parse(io.out()) as Record<string, unknown>
    expect(parsed['rule']).toBeNull()
  })

  test('the effective outcome honours the inventory: clearing the rule of a quarantined tool reports the quarantine source', async () => {
    await writePolicy({ version: 1, servers: { github: { tools: { create_issue: 'allow' } } } })
    const inventory = {
      version: 1,
      servers: {
        github: {
          approved: {},
          quarantined: {
            create_issue: {
              schemaHash: 'a'.repeat(64),
              firstSeenAt: '2026-08-25T00:00:00.000Z',
              state: 'new',
              descriptor: { name: 'create_issue', inputSchema: { type: 'object' } },
            },
          },
        },
      },
    }
    await writeFile(join(journalDir, 'tool-inventory.json'), JSON.stringify(inventory), 'utf8')
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'clear', '--json'], io, await ownerOpts())

    expect(code).toBe(0)
    const parsed = JSON.parse(io.out()) as { effective: { source: string } }
    expect(parsed.effective.source).toBe('quarantine')
  })
})

describe('runPolicySet -- journal and audit', () => {
  test('writes exactly one policy-edit record naming the admin, via cli, with the hashes before and after', async () => {
    await writePolicy(MINIMAL_POLICY)
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'deny', '--json'], io, await ownerOpts())

    expect(code).toBe(0)
    const printed = JSON.parse(io.out()) as { hashBefore: string; hashAfter: string }
    const records = await readJournalRecords(journalDir, POLICY_EDIT_SESSION_ID)
    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe('policy-edit')
    expect(records[0]?.payload).toEqual({
      actor: { adminName: 'alice', role: 'owner', via: 'cli' },
      serverName: 'github',
      toolName: 'create_issue',
      rule: 'deny',
      policyHashBefore: printed.hashBefore,
      policyHashAfter: printed.hashAfter,
      sourcePath: policyPath(),
    })
  })

  test('a clear is journaled with rule: null', async () => {
    await writePolicy(RULED_POLICY)
    const io = fakeIo()

    await runPolicySet(['github', 'list_issues', 'clear'], io, await ownerOpts())

    const payloads = await editRecords()
    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.['rule']).toBeNull()
  })

  test('prints one audit line on stderr naming the admin and the change', async () => {
    await writePolicy(MINIMAL_POLICY)
    const io = fakeIo()

    await runPolicySet(['github', 'create_issue', 'deny'], io, await ownerOpts())

    const auditLines = io.err().split('\n').filter((line) => line.startsWith('[audit]'))
    expect(auditLines).toHaveLength(1)
    expect(auditLines[0]).toContain('alice (owner)')
    expect(auditLines[0]).toContain('github/create_issue = deny')
  })

  test('a dropped journal record is said out loud on stderr, the edit itself stands', async () => {
    await writePolicy(MINIMAL_POLICY)
    const io = fakeIo()

    const code = await runPolicySet(['github', 'create_issue', 'deny'], io, {
      ...(await ownerOpts()),
      deps: {
        sink: {
          retryDelayMs: 0,
          commitBatchImpl: () => {
            throw new Error('simulated commit failure')
          },
        },
      },
    })

    expect(code).toBe(0)
    expect(io.err()).toMatch(/journal record.*dropped/i)
    expect(await readPolicyDocument()).toEqual({
      version: 1,
      servers: { github: { tools: { create_issue: 'deny' } } },
    })
  })
})
