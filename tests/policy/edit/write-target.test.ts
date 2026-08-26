import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  describePolicyReaders,
  policyReadersJson,
  resolvePolicyEditTarget,
  type PolicyEditTargetDeps,
} from '../../../src/policy/edit/write-target.js'

/**
 * The UI and `policy set` edit **the file the entry point itself loaded**
 * (owner decision 2026-08-26, ADR-0009 "Поправка 2026-08-26"): the first
 * candidate of the operator-launched order (ADR-0005) resolved from THIS
 * process's env and cwd — not a hard-wired `<journalDir>/policy.json`. The
 * live install that forced the change: nothing in the state dir, a project
 * file under the operator's cwd, and a plane enforcing exactly that project
 * file while the card claimed there was no policy at all.
 *
 * Who reads the resolved file is computed, never guessed: `connect`
 * (agent-launched) reads `<journalDir>/.mcp-journal/policy.json` then
 * `<journalDir>/policy.json`; every operator-launched entry reads the
 * four-source order.
 */

const JOURNAL_DIR = '/state/mcp-journal'
const WORK_DIR = '/work/project'
const FLAT = join(JOURNAL_DIR, 'policy.json')
const NESTED = join(JOURNAL_DIR, '.mcp-journal', 'policy.json')
const PROJECT = join(WORK_DIR, '.mcp-journal', 'policy.json')

function deps(present: readonly string[]): PolicyEditTargetDeps {
  return { exists: async (path) => present.includes(path) }
}

function target(present: readonly string[], overrides: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  return resolvePolicyEditTarget(
    { journalDir: JOURNAL_DIR, env: overrides.env ?? {}, cwd: overrides.cwd ?? WORK_DIR },
    deps(present),
  )
}

describe('resolvePolicyEditTarget -- which file an edit lands in', () => {
  test('the state-dir file when it is the one that resolves', async () => {
    expect(await target([FLAT])).toEqual({ path: FLAT, readers: { kind: 'every-entry-point' } })
  })

  test('no policy anywhere: the would-be target is the state-dir file, read by every entry point', async () => {
    expect(await target([])).toEqual({ path: FLAT, readers: { kind: 'every-entry-point' } })
  })

  test('the project file under the process cwd wins over the state-dir file, as loadPolicy resolves it', async () => {
    const resolved = await target([PROJECT, FLAT])
    expect(resolved.path).toBe(PROJECT)
  })

  test('$MCP_JOURNAL_POLICY is the target even when the file is missing -- the entry point is bound to that path', async () => {
    const resolved = await target([FLAT], { env: { MCP_JOURNAL_POLICY: '/etc/mcp/policy.json' } })
    expect(resolved.path).toBe('/etc/mcp/policy.json')
  })

  test('an existence probe that throws counts as "not there", never as a throw of its own', async () => {
    const resolved = await resolvePolicyEditTarget(
      { journalDir: JOURNAL_DIR, env: {}, cwd: WORK_DIR },
      {
        exists: async () => {
          throw new Error('EACCES')
        },
      },
    )
    expect(resolved.path).toBe(FLAT)
  })
})

describe('resolvePolicyEditTarget -- who reads the resolved file', () => {
  test('(a) the target is what connect loads too: every entry point', async () => {
    const resolved = await target([FLAT])
    expect(resolved.readers).toEqual({ kind: 'every-entry-point' })
    expect(describePolicyReaders(resolved.readers)).toBe('every entry point reads this file')
  })

  test('(b) a project file while the state dir has one: connect reads that one instead', async () => {
    const resolved = await target([PROJECT, FLAT])
    expect(resolved.readers).toEqual({ kind: 'connect-elsewhere', connectPath: FLAT, shadowsTarget: false })
    expect(describePolicyReaders(resolved.readers)).toBe(`ui/wrap/serve read this file; connect sessions read ${FLAT}`)
  })

  /** The owner's own install: nothing in the state dir, the plane enforcing the project file. */
  test('(b, strong) a project file and no state-dir policy: connect sessions have no policy at all', async () => {
    const resolved = await target([PROJECT])
    expect(resolved.path).toBe(PROJECT)
    expect(resolved.readers).toEqual({ kind: 'connect-unset' })
    expect(describePolicyReaders(resolved.readers)).toBe(
      'ui/wrap/serve read this file; connect sessions have no policy right now (journaling only) — rules here do not reach them',
    )
  })

  test('(c) the state-dir file while the nested connect-first candidate exists: connect reads that one first', async () => {
    const resolved = await target([FLAT, NESTED])
    expect(resolved.path).toBe(FLAT)
    expect(resolved.readers).toEqual({ kind: 'connect-elsewhere', connectPath: NESTED, shadowsTarget: true })
    expect(describePolicyReaders(resolved.readers)).toBe(
      `connect reads ${NESTED} first — rules here reach ui/wrap/serve only`,
    )
  })

  test('the nested file is the target itself when the process cwd is the state dir: every entry point again', async () => {
    const resolved = await target([FLAT, NESTED], { cwd: JOURNAL_DIR })
    expect(resolved.path).toBe(NESTED)
    expect(resolved.readers).toEqual({ kind: 'every-entry-point' })
  })
})

describe('policyReadersJson -- the stable `policy set --json` shape', () => {
  test('every entry point', () => {
    expect(policyReadersJson({ kind: 'every-entry-point' })).toEqual({ connect: true, connectPath: null, operator: true })
  })

  test('connect elsewhere names the path it reads', () => {
    expect(policyReadersJson({ kind: 'connect-elsewhere', connectPath: FLAT, shadowsTarget: false })).toEqual({
      connect: false,
      connectPath: FLAT,
      operator: true,
    })
  })

  test('connect without a policy carries no path', () => {
    expect(policyReadersJson({ kind: 'connect-unset' })).toEqual({ connect: false, connectPath: null, operator: true })
  })
})
