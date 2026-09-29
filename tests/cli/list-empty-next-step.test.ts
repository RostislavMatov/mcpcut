import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { dispatch, type CliIo } from '../../src/cli.js'
import { PRODUCT_VERSION } from '../../src/brand.js'

/**
 * An empty list, or a panel with nothing set up yet, ends with the command
 * that fills it (owner's rule 2026-09-29). The console's Servers, Agents,
 * Groups, Vault and Policy panels show exactly this output, so the words are
 * checked where both the shell and the console get them. Hints go to stderr:
 * stdout stays the command's data.
 */

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-list-next-step-'))
  vi.stubEnv('npm_command', '')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(journalDir, { recursive: true, force: true })
})

interface CapturedIo extends CliIo {
  out(): string
  err(): string
}

function capturedIo(): CapturedIo {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

async function run(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const io = capturedIo()
  const code = await dispatch([...argv], io, {
    server: { journalDir, env: {} },
    agent: { journalDir, env: {} },
    group: { journalDir, env: {} },
    vault: { journalDir, env: {} },
    policy: { journalDir, cwd: journalDir, env: {} },
  })
  return { code, out: io.out(), err: io.err() }
}

describe('empty lists name the command that fills them', () => {
  test('server list: no servers → the server add command', async () => {
    const { code, out, err } = await run(['server', 'list'])

    expect(code).toBe(0)
    expect(out).toBe('(no servers registered)\n')
    expect(err).toContain('mcpcut server add <name> --transport stdio --command <server command>')
  })

  test('agent list: no agents → the agent create command', async () => {
    const { code, out, err } = await run(['agent', 'list'])

    expect(code).toBe(0)
    expect(out).toBe('(no agents)\n')
    expect(err).toContain('mcpcut agent create <name>')
  })

  test('group list: no groups → the group create command', async () => {
    const { code, out, err } = await run(['group', 'list'])

    expect(code).toBe(0)
    expect(out).toBe('(no groups)\n')
    expect(err).toContain('mcpcut group create <name>')
  })

  test('under npx the hint names the npx form', async () => {
    vi.stubEnv('npm_command', 'exec')

    const { err } = await run(['server', 'list'])

    expect(err).toContain(`npx -y mcpcut@${PRODUCT_VERSION} server add`)
  })
})

describe('a panel with nothing set up says how to set it up', () => {
  test('vault list before init names the init command in the form this process runs', async () => {
    vi.stubEnv('npm_command', 'exec')

    const { code, err } = await run(['vault', 'list'])

    expect(code).toBe(1)
    expect(err).toContain(`npx -y mcpcut@${PRODUCT_VERSION} vault init`)
  })

  test('policy show with no policy file says what that means and where the file goes', async () => {
    const { code, err } = await run(['policy', 'show'])

    expect(code).toBe(1)
    expect(err).toContain('no policy file found')
    // The last line is the next step: no file means no rules, and the
    // home-level path is where one is created.
    const [meaning, next] = err.trimEnd().split('\n').slice(-2)
    expect(meaning).toBe('No policy file means every call runs and is journaled.')
    expect(next).toContain(`create ${join(journalDir, 'policy.json')}`)
  })
})
