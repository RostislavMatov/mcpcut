import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

const COVERAGE_THRESHOLD_PERCENT = 80

/**
 * A fresh home for every run. The default data directory is built from
 * `homedir()`, and a console opened without a `journalDir` seam reads — and
 * creates — `~/.mcpcut/data`: on the developer's machine that was the owner's
 * real install (a sign-in screen, green), on a clean CI runner an empty one
 * (the first-owner screen, red). Guarded by `tests/architecture/test-home.test.ts`.
 */
const TEST_HOME = mkdtempSync(join(tmpdir(), 'mcpcut-test-home-'))
process.on('exit', () => rmSync(TEST_HOME, { recursive: true, force: true }))

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    /**
     * `src/config.ts` resolves the data directory from `~/.mcpcut/config.json`
     * while it is being imported (phase 1, task 4). Without these two the
     * suite would read whatever the developer's machine happens to hold, and
     * a green run would say nothing about a clean one. `MCPCUT_CONFIG` points
     * at a path that cannot exist; `MCPCUT_DATA_DIR` is emptied, which every
     * env seam here reads as "not set".
     */
    env: {
      HOME: TEST_HOME,
      MCPCUT_CONFIG: '/nonexistent/mcpcut-test/config.json',
      MCPCUT_DATA_DIR: '',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts'],
      thresholds: {
        lines: COVERAGE_THRESHOLD_PERCENT,
        functions: COVERAGE_THRESHOLD_PERCENT,
        branches: COVERAGE_THRESHOLD_PERCENT,
        statements: COVERAGE_THRESHOLD_PERCENT,
      },
    },
  },
})
