import { defineConfig } from 'vitest/config'

const COVERAGE_THRESHOLD_PERCENT = 80

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    /**
     * `src/config.ts` resolves the data directory from `~/.mcpcut/config.json`
     * while it is being imported (phase 1, task 4). Without these two the
     * suite would read whatever the developer's machine happens to hold, and
     * a green run would say nothing about a clean one. `MCPCUT_CONFIG` points
     * at a path that cannot exist; `MCP_JOURNAL_DIR` is emptied, which every
     * env seam here reads as "not set".
     */
    env: {
      MCPCUT_CONFIG: '/nonexistent/mcpcut-test/config.json',
      MCP_JOURNAL_DIR: '',
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
