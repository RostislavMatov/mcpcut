import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { readPolicyView, type ReadPolicyViewDeps } from '../../../src/policy/edit/policy-view.js'
import type { PolicyFileReadResult } from '../../../src/policy/edit/policy-file.js'
import { parsePolicy, type Policy } from '../../../src/policy/schema.js'

/**
 * `readPolicyView` is what the admin UI renders the policy from (plan
 * policy-tool-rules-ui §6): the flat `<journalDir>/policy.json` read for
 * edit, the shadowing nested file `connect` would load first (finding 5a),
 * and — when it differs — the file an operator-launched `serve`/`wrap` would
 * load first from the UI process's own env/cwd (the ADR-0005 sources panel).
 */

const JOURNAL_DIR = '/state/mcp-journal'
const FLAT = join(JOURNAL_DIR, 'policy.json')
const NESTED = join(JOURNAL_DIR, '.mcp-journal', 'policy.json')

function policyOf(raw: unknown): Policy {
  const parsed = parsePolicy(raw)
  if (!parsed.ok) throw new Error('bad fixture')
  return parsed.policy
}

const LOADED: PolicyFileReadResult = {
  status: 'loaded',
  policy: policyOf({ version: 1 }),
  hash: 'a'.repeat(64),
  raw: '{"version":1}\n',
  document: { version: 1 },
}

function deps(overrides: Partial<ReadPolicyViewDeps> & { readonly existing?: readonly string[] }): ReadPolicyViewDeps {
  const existing = new Set(overrides.existing ?? [])
  return {
    resolveWriteTarget: async (dir) => ({ status: 'ok', path: join(dir, 'policy.json') }),
    readPolicyFile: async () => LOADED,
    exists: async (path) => existing.has(path),
    ...overrides,
  }
}

describe('readPolicyView', () => {
  test('a loaded flat file → loaded with hash and the write path as sourcePath', async () => {
    const view = await readPolicyView({ journalDir: JOURNAL_DIR, env: {}, cwd: '/somewhere' }, deps({}))

    expect(view.status).toBe('loaded')
    expect(view.sourcePath).toBe(FLAT)
    expect(view.shadowedBy).toBeUndefined()
    expect(view.operatorSourcePath).toBeUndefined()
    if (view.status === 'loaded') expect(view.hash).toBe(LOADED.hash)
  })

  test('absent and error results are passed through with the same source fields', async () => {
    const absent = await readPolicyView(
      { journalDir: JOURNAL_DIR, env: {}, cwd: '/x' },
      deps({ readPolicyFile: async () => ({ status: 'absent' }) }),
    )
    const error = await readPolicyView(
      { journalDir: JOURNAL_DIR, env: {}, cwd: '/x' },
      deps({ readPolicyFile: async () => ({ status: 'error', errors: ['boom'] }) }),
    )

    expect(absent).toEqual({ status: 'absent', sourcePath: FLAT })
    expect(error).toEqual({ status: 'error', errors: ['boom'], sourcePath: FLAT })
  })

  test('a shadowing nested file is reported as shadowedBy (finding 5a) and the file is still read', async () => {
    const view = await readPolicyView(
      { journalDir: JOURNAL_DIR, env: {}, cwd: '/x' },
      deps({ resolveWriteTarget: async () => ({ status: 'shadowed', path: FLAT, shadowedBy: NESTED }) }),
    )

    expect(view.status).toBe('loaded')
    expect(view.shadowedBy).toBe(NESTED)
  })

  test('the operator source is the project-level file when it exists in the UI process cwd', async () => {
    const cwd = '/work/project'
    const projectFile = resolve(cwd, '.mcp-journal', 'policy.json')

    const view = await readPolicyView({ journalDir: JOURNAL_DIR, env: {}, cwd }, deps({ existing: [projectFile] }))

    expect(view.operatorSourcePath).toBe(projectFile)
  })

  test('the operator source is $MCP_JOURNAL_POLICY when set, even if the file is missing (required source)', async () => {
    const view = await readPolicyView(
      { journalDir: JOURNAL_DIR, env: { MCP_JOURNAL_POLICY: '/etc/mcp/policy.json' }, cwd: '/x' },
      deps({}),
    )

    expect(view.operatorSourcePath).toBe('/etc/mcp/policy.json')
  })

  test('no operator source is reported when serve/wrap would load the same flat file', async () => {
    const view = await readPolicyView({ journalDir: JOURNAL_DIR, env: {}, cwd: '/x' }, deps({ existing: [FLAT] }))

    expect(view.operatorSourcePath).toBeUndefined()
  })

  test('a failing existence probe counts as "not there" for the operator source, never as a throw', async () => {
    const view = await readPolicyView(
      { journalDir: JOURNAL_DIR, env: {}, cwd: '/x' },
      deps({ exists: async () => { throw new Error('EACCES') } }),
    )

    expect(view.status).toBe('loaded')
    expect(view.operatorSourcePath).toBeUndefined()
  })
})
