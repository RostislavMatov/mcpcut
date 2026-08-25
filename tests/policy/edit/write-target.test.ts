import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { resolvePolicyWriteTarget } from '../../../src/policy/edit/write-target.js'

/**
 * UI and `policy set` write exactly one file, `<journalDir>/policy.json` —
 * the source every entry point falls back to and the one `connect`
 * (agent-launched, ADR-0005) reads. But `connect` resolves
 * `<journalDir>/.mcp-journal/policy.json` FIRST: while that file exists an
 * edit to the flat file would be written "into nowhere" for agents. The
 * target resolver refuses in that case instead of writing silently.
 */
describe('resolvePolicyWriteTarget', () => {
  const journalDir = '/home/op/.mcp-journal'
  const flat = join(journalDir, 'policy.json')
  const nested = join(journalDir, '.mcp-journal', 'policy.json')

  function existsOnly(present: readonly string[]): (path: string) => Promise<boolean> {
    return async (path) => present.includes(path)
  }

  test('names the flat state-dir file when nothing shadows it', async () => {
    const target = await resolvePolicyWriteTarget(journalDir, { exists: existsOnly([flat]) })
    expect(target).toEqual({ status: 'ok', path: flat })
  })

  test('the flat file need not exist yet — absence is the caller\'s business', async () => {
    const target = await resolvePolicyWriteTarget(journalDir, { exists: existsOnly([]) })
    expect(target).toEqual({ status: 'ok', path: flat })
  })

  test('refuses while the nested connect-first candidate exists', async () => {
    const target = await resolvePolicyWriteTarget(journalDir, { exists: existsOnly([flat, nested]) })
    expect(target).toEqual({ status: 'shadowed', path: flat, shadowedBy: nested })
  })

  test('a failing existence probe counts as shadowed — never write on a guess', async () => {
    const target = await resolvePolicyWriteTarget(journalDir, {
      exists: async () => {
        throw new Error('EACCES')
      },
    })
    expect(target.status).toBe('shadowed')
  })
})
