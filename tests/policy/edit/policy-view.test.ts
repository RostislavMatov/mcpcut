import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  isQuarantineHolding,
  readPolicyView,
  readQuarantineHolding,
  type PolicyView,
  type ReadPolicyViewDeps,
} from '../../../src/policy/edit/policy-view.js'
import type { PolicyFileReadResult } from '../../../src/policy/edit/policy-file.js'
import { parsePolicy, type Policy } from '../../../src/policy/schema.js'

/**
 * `readPolicyView` is what the admin UI renders the policy from (plan
 * policy-tool-rules-ui §6, corrected 2026-08-26): the file THIS process
 * resolved through the operator-launched order, read for edit, plus the
 * computed statement of which entry points read it. There is no second
 * "source" field any more — the file shown is the file edited.
 */

const JOURNAL_DIR = '/state/mcpcut'
const WORK_DIR = '/work/project'
const FLAT = join(JOURNAL_DIR, 'policy.json')
const PROJECT = join(WORK_DIR, '.mcpcut-project', 'policy.json')

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
    await readPolicyView({ journalDir: JOURNAL_DIR, env: { MCPCUT_POLICY: '/etc/p.json' }, cwd: WORK_DIR }, deps({
      resolveTarget: async (args) => {
        seen.push(args)
        return { path: FLAT, readers: { kind: 'every-entry-point' } }
      },
    }))

    expect(seen).toEqual([{ journalDir: JOURNAL_DIR, env: { MCPCUT_POLICY: '/etc/p.json' }, cwd: WORK_DIR }])
  })
})

describe('whether quarantine holds (ADR-0009 amendment 2026-10-02)', () => {
  const sources = { sourcePath: FLAT, readers: { kind: 'every-entry-point' as const } }
  const loaded = (raw: unknown): PolicyView => ({ ...sources, status: 'loaded', policy: policyOf(raw), hash: 'b'.repeat(64) })

  test('only a loaded policy that turns it off says it does not hold', () => {
    expect(isQuarantineHolding(loaded({ version: 1, quarantine: { enabled: false } }))).toBe(false)
    expect(isQuarantineHolding(loaded({ version: 1, quarantine: { enabled: true } }))).toBe(true)
    expect(isQuarantineHolding(loaded({ version: 1 }))).toBe(true)
  })

  test('an absent or broken file reads as holding, never as off', () => {
    expect(isQuarantineHolding({ ...sources, status: 'absent' })).toBe(true)
    expect(isQuarantineHolding({ ...sources, status: 'error', errors: ['bad json'] })).toBe(true)
  })

  test('a read that throws reads as holding and is reported, so the dashboard still renders', async () => {
    const reported: unknown[] = []
    const failure = new Error('EACCES')
    const isHolding = await readQuarantineHolding(
      async () => {
        throw failure
      },
      (error) => reported.push(error),
    )
    expect(isHolding).toBe(true)
    expect(reported).toEqual([failure])
  })

  test('a read that succeeds is decided by the view', async () => {
    const reported: unknown[] = []
    const off = loaded({ version: 1, quarantine: { enabled: false } })
    expect(await readQuarantineHolding(async () => off, (error) => reported.push(error))).toBe(false)
    expect(reported).toEqual([])
  })
})
