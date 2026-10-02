import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { CLIENT_IDS } from '../../src/adopt/clients.js'
import { runAdoptCommand } from '../../src/cli/adopt-cmd.js'
import { AGENTS_SECTION } from '../../src/tui/catalogue/agents.js'
import type { FormValues } from '../../src/tui/form.js'

/**
 * The argv the console builds for `adopt` is fed to the CLI's real parser, so
 * the form cannot offer a combination the command refuses. Everything runs in
 * a temp home and data dir — never the real ones.
 */

const TICKED = 'true'
const adopts = AGENTS_SECTION.actions.filter((action) => action.command === 'adopt')

/** None ticked, each client alone, and all of them. */
const SELECTIONS: readonly FormValues[] = [
  {},
  ...CLIENT_IDS.map((id) => ({ [id]: TICKED })),
  Object.fromEntries(CLIENT_IDS.map((id) => [id, TICKED])),
]

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adopt-console-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function run(argv: readonly string[]): Promise<{ code: number; stderr: string }> {
  let stderr = ''
  const sink = { write: (chunk: string) => chunk.length }
  const code = await runAdoptCommand(argv.slice(1), { stdout: sink, stderr: { write: (chunk) => (stderr += chunk) } }, {
    place: { home: join(root, 'home'), cwd: join(root, 'cwd'), platform: 'linux' },
    journalDir: join(root, 'data'),
  })
  return { code, stderr }
}

describe('every argv the Agents form builds is accepted by the adopt parser', () => {
  test.each(adopts.flatMap((action) => SELECTIONS.map((values) => [action.id, values] as const)))(
    '%s with %j',
    async (id, values) => {
      const action = adopts.find((each) => each.id === id)
      const argv = action?.argv(values) ?? []

      const { stderr } = await run(argv)

      expect(argv[0]).toBe('adopt')
      expect(stderr).not.toContain('Usage:')
      expect(stderr).not.toContain('Unknown client')
    },
  )
})
