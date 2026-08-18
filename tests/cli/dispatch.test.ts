import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { dispatch, type CliIo } from '../../src/cli.js'
import type { JournalRecord } from '../../src/journal/record.js'
import { createJournalSink } from '../../src/journal/sink.js'
import { createClientHarness } from '../proxy/harness.js'

/**
 * Dispatcher-level routing tests: every subcommand is driven through
 * `dispatch()` directly (no subprocess), each isolated from real disk state
 * via the per-command test seams in `DispatchOptions`.
 */

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-dispatch-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

/** Captures stdout/stderr writes for assertions instead of touching the real streams. */
function fakeIo(): CliIo & { readonly out: () => string; readonly err: () => string } {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

describe('dispatch: unknown command', () => {
  test('prints usage to stderr and returns 1', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['bogus'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Unknown command: bogus')
    expect(io.err()).toContain('Usage:')
  })
})

describe('dispatch: policy validate', () => {
  test('routes to policy-cmd and returns 0 for a valid file', async () => {
    const io = fakeIo()
    const path = join(tempDir, 'policy.json')
    await writeFile(path, JSON.stringify({ version: 1, defaultDecision: 'allow' }), 'utf8')

    const exitCode = await dispatch(['policy', 'validate', path], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('OK')
  })
})

describe('dispatch: quarantine list', () => {
  test('routes to quarantine-cmd with an isolated store', async () => {
    const io = fakeIo()
    const storePath = join(tempDir, 'tool-inventory.json')

    const exitCode = await dispatch(['quarantine', 'list'], io, { quarantine: { storePath } })

    expect(exitCode).toBe(0)
    expect(io.out()).toBe('no quarantined tools\n')
  })
})

describe('dispatch: approvals list', () => {
  test('routes to approvals-cmd with an isolated queue', async () => {
    const io = fakeIo()
    const baseDir = join(tempDir, 'approvals')

    const exitCode = await dispatch(['approvals', 'list'], io, { approvals: { baseDir } })

    expect(exitCode).toBe(0)
    expect(io.out()).toBe('no pending approvals\n')
  })
})

describe('dispatch: wrap', () => {
  test('unknown flag before "--" fails fast with exit 1', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['wrap', '--unknown-flag', '--', 'node', '-e', 'process.exit(0)'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })

  test('--no-policy runs mode A and returns the child exit code', async () => {
    const io = fakeIo()
    const harness = createClientHarness()

    const exitCode = await dispatch(['wrap', '--no-policy', '--', 'node', '-e', 'process.exit(0)'], io, {
      wrap: {
        runWrap: {
          dir: tempDir,
          stdin: harness.clientOutbox,
          stdout: harness.clientStdout,
          stderr: harness.clientStderr,
        },
      },
    })

    expect(exitCode).toBe(0)
  })

  test('a broken --policy file fails fast with exit 1, without spawning the child', async () => {
    const io = fakeIo()
    const harness = createClientHarness()
    const brokenPath = join(tempDir, 'broken.json')
    await writeFile(brokenPath, '{ not json', 'utf8')

    const exitCode = await dispatch(
      ['wrap', '--policy', brokenPath, '--', 'node', '-e', 'process.exit(1)'],
      io,
      {
        wrap: {
          runWrap: {
            dir: tempDir,
            stdin: harness.clientOutbox,
            stdout: harness.clientStdout,
            stderr: harness.clientStderr,
          },
        },
      },
    )

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(brokenPath)
    // The child was never spawned: its exit code (1) never determined the outcome, the
    // policy load failure did (also 1) -- assert on the message instead, which only the
    // policy-load path writes.
    expect(io.err()).not.toContain('policy: loaded')
  })
})

describe('dispatch: show (regression)', () => {
  test('--kind decision still filters and prints readable records', async () => {
    const io = fakeIo()
    const sessionId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    const decisionRecord = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
      ts: '2026-08-05T00:00:00.000Z',
      sessionId,
      direction: 'client→server',
      kind: 'decision',
      method: 'tools/call',
      payload: {},
      decision: {
        outcome: 'deny',
        rule: 'servers.github.tools.delete_*',
        serverName: 'github',
        toolName: 'delete_repo',
        toolClass: 'destructive',
        quarantineState: 'known',
        argsHash: 'abc123',
      },
    }
    const requestRecord = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FA2',
      ts: '2026-08-05T00:00:01.000Z',
      sessionId,
      direction: 'client→server',
      kind: 'request',
      method: 'tools/list',
      payload: {},
    }
    // Through the real sink: `journal.db` is the only read carrier since the
    // M4.5 wave-5 cutover, so a hand-written `*.jsonl` would show nothing.
    const sink = createJournalSink(sessionId, { dir: tempDir })
    sink.write(decisionRecord as JournalRecord)
    sink.write(requestRecord as JournalRecord)
    await sink.close()

    const exitCode = await dispatch(['show', sessionId, '--kind', 'decision'], io, { journalDir: tempDir })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('delete_repo')
    expect(io.out()).not.toContain('tools/list')
  })
})

describe('dispatch: M3 commands route to their modules', () => {
  test('--help lists every M3 command', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['--help'], io)

    expect(exitCode).toBe(0)
    for (const name of ['connect', 'serve', 'server add', 'vault init', 'agent create']) {
      expect(io.out()).toContain(name)
    }
  })

  test('server: missing subcommand prints usage with exit 1', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['server'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Missing server subcommand.')
  })

  test('server list routes with an isolated registry', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['server', 'list'], io, { server: { journalDir: tempDir } })

    expect(exitCode).toBe(0)
    expect(io.out().toLowerCase()).toContain('no servers')
  })

  test('vault list without init reports not-initialized with a hint', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['vault', 'list'], io, { vault: { journalDir: tempDir } })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('vault init')
  })

  test('agent list routes with an isolated store', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['agent', 'list'], io, { agent: { journalDir: tempDir } })

    expect(exitCode).toBe(0)
  })

  test('connect without MCP_AGENT_TOKEN refuses before any traffic', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['connect', 'github', '--agent', 'bot'], io, {
      connect: { env: {}, journalDir: tempDir },
    })

    expect(exitCode).not.toBe(0)
    expect(io.err()).toContain('MCP_AGENT_TOKEN')
  })

  test('serve with an invalid port refuses to start', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['serve', '--port', 'not-a-port'], io, {
      serve: { journalDir: tempDir },
    })

    expect(exitCode).not.toBe(0)
  })
})

describe('dispatch: migrate', () => {
  test('routes to migrate-cmd with an isolated journalDir', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['migrate'], io, { migrate: { journalDir: tempDir } })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('no file')
    expect(io.out()).toContain('Migrated 0 store(s).')
  })
})

describe('dispatch: export', () => {
  test('routes to export-cmd with an isolated journalDir', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['export'], io, { export: { journalDir: tempDir } })

    expect(exitCode).toBe(0)
    expect(io.out()).toBe('')
  })
})

describe('dispatch: backup', () => {
  test('routes to backup-cmd with an isolated journalDir', async () => {
    const io = fakeIo()
    const destDir = join(tempDir, 'backup-dest')

    const exitCode = await dispatch(['backup', destDir], io, { backup: { journalDir: tempDir } })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('No databases to back up.')
  })
})

describe('dispatch: verify', () => {
  test('routes to verify-cmd with an isolated journalDir', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['verify'], io, { verify: { journalDir: tempDir } })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('No journal database found')
  })
})

describe('dispatch: prune', () => {
  test('routes to prune-cmd with an isolated journalDir', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['prune', '--older-than', '90d'], io, { prune: { journalDir: tempDir } })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('No journal database found')
  })

  test('a prune with no --older-than never reaches the journal', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['prune'], io, { prune: { journalDir: tempDir } })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('--older-than')
  })
})

describe('dispatch: keygen', () => {
  test('routes to keygen-cmd with an isolated journalDir', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['keygen'], io, { keygen: { journalDir: join(tempDir, 'keygen') } })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('-----BEGIN PUBLIC KEY-----')
  })
})
