import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { readPolicyView, type ReadPolicyViewDeps } from '../../../src/policy/edit/policy-view.js'
import type { PolicyFileReadResult } from '../../../src/policy/edit/policy-file.js'
import { parsePolicy, type Policy } from '../../../src/policy/schema.js'

/**
 * `readPolicyView` is what the admin UI renders the policy from (plan
 * policy-tool-rules-ui §6, corrected 2026-08-26): the file THIS process
 * resolved through the operator-launched order, read for edit, plus the
 * computed statement of which entry points read it. There is no second
 * "source" field any more — the file shown is the file edited.
 */

const JOURNAL_DIR = '/state/mcp-journal'
const WORK_DIR = '/work/project'
const FLAT = join(JOURNAL_DIR, 'policy.json')
const PROJECT = join(WORK_DIR, '.mcp-journal', 'policy.json')

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

function deps(overrides: Partial<ReadPolicyViewDeps> = {}): ReadPolicyViewDeps {
  return {
    resolveTarget: async () => ({ path: FLAT, readers: { kind: 'every-entry-point' } }),
    readPolicyFile: async () => LOADED,
    ...overrides,
  }
}

const ARGS = { journalDir: JOURNAL_DIR, env: {}, cwd: WORK_DIR }

describe('readPolicyView', () => {
  test('the resolved target is read, and its path and readers are the view sources', async () => {
    const view = await readPolicyView(ARGS, deps())

    expect(view.status).toBe('loaded')
    expect(view.sourcePath).toBe(FLAT)
    expect(view.readers).toEqual({ kind: 'every-entry-point' })
    if (view.status === 'loaded') expect(view.hash).toBe(LOADED.hash)
  })

  test('absent and error results are passed through with the same source fields', async () => {
    const absent = await readPolicyView(ARGS, deps({ readPolicyFile: async () => ({ status: 'absent' }) }))
    const error = await readPolicyView(ARGS, deps({ readPolicyFile: async () => ({ status: 'error', errors: ['boom'] }) }))

    expect(absent).toEqual({ status: 'absent', sourcePath: FLAT, readers: { kind: 'every-entry-point' } })
    expect(error).toEqual({ status: 'error', errors: ['boom'], sourcePath: FLAT, readers: { kind: 'every-entry-point' } })
  })

  /**
   * The live install that forced the 2026-08-26 correction: nothing in the
   * state dir, a project file under the operator's cwd. The view must show
   * that file — loaded, editable — and say that `connect` is untouched by it.
   */
  test('a project-level file with an empty state dir: that file is the view, connect is stated as policy-less', async () => {
    const readPaths: string[] = []
    const view = await readPolicyView(
      ARGS,
      deps({
        resolveTarget: async () => ({ path: PROJECT, readers: { kind: 'connect-unset' } }),
        readPolicyFile: async (path) => {
          readPaths.push(path)
          return LOADED
        },
      }),
    )

    expect(readPaths).toEqual([PROJECT])
    expect(view.status).toBe('loaded')
    expect(view.sourcePath).toBe(PROJECT)
    expect(view.readers).toEqual({ kind: 'connect-unset' })
  })

  test('the target resolver is given this process\'s journalDir, env and cwd', async () => {
    const seen: unknown[] = []
    await readPolicyView({ journalDir: JOURNAL_DIR, env: { MCP_JOURNAL_POLICY: '/etc/p.json' }, cwd: WORK_DIR }, deps({
      resolveTarget: async (args) => {
        seen.push(args)
        return { path: FLAT, readers: { kind: 'every-entry-point' } }
      },
    }))

    expect(seen).toEqual([{ journalDir: JOURNAL_DIR, env: { MCP_JOURNAL_POLICY: '/etc/p.json' }, cwd: WORK_DIR }])
  })
})
