import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runWrapCommand } from '../../src/cli/wrap-cmd.js'
import { autoServerName } from '../../src/proxy/wire-policy.js'
import { writeCorruptDatabase, writeUnopenableDatabase } from '../support/corrupt-db.js'

/**
 * `mcpcut wrap`'s startup gate. Routing and policy resolution for this
 * command are covered by `tests/cli/dispatch.test.ts`; what lives here is the
 * M4.5 wave-5 preflight, which must refuse a damaged database BEFORE the
 * wrapped server is spawned — a wrap that spawned first would run a whole
 * session whose journal cannot be trusted.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-wrap-cmd-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

/** Captures stderr writes for assertions instead of touching the real stream. */
function fakeIo(): { stderr: { write: (chunk: string) => void }; err: () => string } {
  const chunks: string[] = []
  return {
    stderr: { write: (chunk: string) => chunks.push(chunk) },
    err: () => chunks.join(''),
  }
}

describe('runWrapCommand: startup integrity preflight', () => {
  test('a damaged state.db refuses the run without spawning the server', async () => {
    await writeCorruptDatabase(join(journalDir, 'state.db'))
    const io = fakeIo()

    // The child would exit 7 if it ever ran, so the exit code alone
    // distinguishes "refused before spawning" from "spawned and relayed".
    const exitCode = await runWrapCommand(
      ['--no-policy', '--', process.execPath, '-e', 'process.exit(7)'],
      io,
      { runWrap: { dir: journalDir } },
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('state.db failed PRAGMA integrity_check')
    expect(io.err()).toContain('Refusing to start.')
  })

  test('a state.db that cannot be opened at all refuses with the same restore guidance', async () => {
    await writeUnopenableDatabase(join(journalDir, 'state.db'))
    const io = fakeIo()

    const exitCode = await runWrapCommand(
      ['--no-policy', '--', process.execPath, '-e', 'process.exit(7)'],
      io,
      { runWrap: { dir: journalDir } },
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('state.db cannot be opened')
    expect(io.err()).toContain('Refusing to start.')
    expect(io.err()).toContain('Backup & restore')
  })

  test('a journal directory with no databases yet is not a refusal', async () => {
    const io = fakeIo()

    const exitCode = await runWrapCommand(
      ['--no-policy', '--', process.execPath, '-e', 'process.exit(0)'],
      io,
      { runWrap: { dir: journalDir } },
    )

    expect(exitCode).toBe(0)
    expect(io.err()).not.toContain('integrity_check')
  })
})

describe('runWrapCommand: the auto: server name', () => {
  const child = [process.execPath, '-e', 'process.exit(0)'] as const

  test('without --server it says, once, which name the queue and the journal will show and how to pick one', async () => {
    const io = fakeIo()

    const exitCode = await runWrapCommand(['--no-policy', '--', ...child], io, { runWrap: { dir: journalDir } })

    const name = autoServerName(child[0], child.slice(1))
    expect(exitCode).toBe(0)
    expect(io.err()).toContain(`wrap: server name is ${name}; pass --server <name> for a readable one\n`)
    expect(io.err().split(name)).toHaveLength(2)
  })

  test('with --server there is nothing to say', async () => {
    const io = fakeIo()

    const exitCode = await runWrapCommand(['--no-policy', '--server', 'memory', '--', ...child], io, {
      runWrap: { dir: journalDir },
    })

    expect(exitCode).toBe(0)
    expect(io.err()).not.toContain('auto:')
  })

  test('a wrap refused before it runs does not name a server it never started', async () => {
    await writeCorruptDatabase(join(journalDir, 'state.db'))
    const io = fakeIo()

    await runWrapCommand(['--no-policy', '--', ...child], io, { runWrap: { dir: journalDir } })

    expect(io.err()).not.toContain('auto:')
  })
})
