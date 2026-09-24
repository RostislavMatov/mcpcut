import { homedir, tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'
import { realpathSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { JOURNAL_DIR } from '../../src/config.js'

/**
 * The default data directory is `~/.mcpcut/data`. A test that opens the
 * console without a `journalDir` seam reads — and creates — whatever lives
 * there, so on the developer's machine it found the owner's real install and
 * passed, while on a clean CI runner it found nothing and failed. The suite
 * therefore runs under a fresh, throwaway home: a green run says the same
 * thing on every machine and never touches the real `~/.mcpcut`.
 */
describe('the suite runs under a throwaway home', () => {
  test('homedir() is a fresh directory under the system temp dir', () => {
    expect(realpathSync(dirname(homedir()))).toBe(realpathSync(tmpdir()))
    expect(basename(homedir())).toMatch(/^mcpcut-test-home-/)
  })

  test('the default data directory lives inside that home', () => {
    expect(JOURNAL_DIR.startsWith(homedir())).toBe(true)
  })
})
