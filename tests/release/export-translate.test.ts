import { afterEach, describe, expect, test } from 'vitest'
import { EXPORT_TIMEOUT_MS, RULES_DIR, commit, exportFixture, git, hasFilterRepo, rulesFiles, runExport } from './export-fixture.js'

/**
 * The public history is English (decision 2026-09-25). A message in Cyrillic
 * letters stops the export; translate-message.json gives the messages written
 * before that rule their English text; and a commit id such a text cites has
 * to come out as a public id, or the export stops rather than publish a
 * private one.
 */

const CYRILLIC = /[Ѐ-ӿ]/

describe.skipIf(!hasFilterRepo)('export-public.mjs: English commit messages', () => {
  const fixture = exportFixture()
  const { source, target } = fixture

  afterEach(fixture.cleanup)

  /**
   * The four standard commits, then a Russian one and a later one, and an
   * English text for the Russian commit citing the id `cite` picks once they
   * all exist. Public `main~1` is the translated commit (the rules commit
   * touches only `.claude/` and is dropped).
   */
  function translated(cite: (from: string) => string): { readonly from: string; readonly cited: string } {
    const from = source()
    commit(from, { 'd.txt': 'd\n' }, 'docs: заметки')
    const russian = git(from, ['rev-parse', 'HEAD'])
    commit(from, { 'e.txt': 'e\n' }, 'feat: later')
    const cited = cite(from)
    const english = `docs: notes on ${cited}\n\nThe body stays a body.\n`
    commit(from, rulesFiles({ 'translate-message.json': JSON.stringify({ [russian]: english }) }), 'docs: an English text')
    return { from, cited }
  }

  test(
    'a message in Cyrillic letters without an English text stops the export, named by both ids, never quoted',
    async () => {
      const from = source()
      commit(from, { 'd.txt': 'd\n' }, 'docs: заметки о выпуске')
      const to = target()

      const result = await runExport(from, [to])

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/message of commit [0-9a-f]{7,} \(source [0-9a-f]{7,}\) is in Cyrillic letters/)
      expect(result.stderr).not.toMatch(CYRILLIC)
      expect(git(to, ['rev-list', '--all']).length).toBe(0)
    },
    EXPORT_TIMEOUT_MS,
  )

  test(
    'an English text replaces the message, and a commit id it cites becomes the public one',
    async () => {
      const { from, cited } = translated((repo) => git(repo, ['rev-list', '--max-parents=0', 'main']).slice(0, 7))
      const to = target()

      const result = await runExport(from, [to])

      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      const firstPublic = git(to, ['rev-list', '--max-parents=0', 'main']).slice(0, 7)
      expect(firstPublic).not.toBe(cited)
      expect(git(to, ['log', '-1', '--format=%B', 'main~1'])).toBe(`docs: notes on ${firstPublic}\n\nThe body stays a body.`)
    },
    EXPORT_TIMEOUT_MS,
  )

  test.each([
    ['a later commit', (repo: string): string => git(repo, ['rev-parse', 'HEAD']).slice(0, 7)],
    // `docs: working notes` touches only `.claude/`: the filter drops it, so its id has nothing to become.
    [
      'a commit the filter drops',
      (repo: string): string => git(repo, ['log', '-1', '--format=%H', '--grep=^docs: working notes$', 'main']).slice(0, 7),
    ],
  ])(
    'an English text citing %s stops the export: its private id would be published',
    async (_case, cite) => {
      const { from, cited } = translated(cite)
      const to = target()

      const result = await runExport(from, [to])

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/message of commit [0-9a-f]{7,} \(source [0-9a-f]{7,}\) cites 1 commit id of the source/)
      expect(result.stderr).not.toContain(cited)
      expect(git(to, ['rev-list', '--all']).length).toBe(0)
    },
    EXPORT_TIMEOUT_MS,
  )

  test(
    'an English text for a commit the source does not have stops the export, named by id',
    async () => {
      const ghost = 'f'.repeat(40)
      const from = source({ 'translate-message.json': JSON.stringify({ [ghost]: 'docs: ghost\n' }) })
      const to = target()

      const result = await runExport(from, [to])

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(new RegExp(`translate-message\\.json: ${ghost} is not a commit of the source`))
      expect(git(to, ['rev-list', '--all']).length).toBe(0)
    },
    EXPORT_TIMEOUT_MS,
  )

  test(
    'a missing translate-message.json is named like any other rules file',
    async () => {
      const from = source()
      git(from, ['rm', '-q', `${RULES_DIR}/translate-message.json`])
      git(from, ['commit', '-q', '-m', 'drop translations'])

      const result = await runExport(from, [target()])

      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/missing rules file .*translate-message\.json/)
    },
    EXPORT_TIMEOUT_MS,
  )
})
