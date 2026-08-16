import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { resolveConnectPolicy } from '../../src/cli/connect-policy.js'
import { runPolicyShow, runPolicyValidate } from '../../src/cli/policy-cmd.js'

let cwd: string
let journalDir: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'mcp-journal-policy-cmd-cwd-'))
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-policy-cmd-home-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
  await rm(journalDir, { recursive: true, force: true })
})

/** Captures stdout/stderr writes for assertions instead of touching the real streams. */
function fakeIo(): { stdout: { write: (chunk: string) => void }; stderr: { write: (chunk: string) => void }; out: () => string; err: () => string } {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

const VALID_POLICY = {
  version: 1,
  defaultDecision: 'require-approval',
  servers: {
    github: {
      defaultDecision: 'allow',
      tools: { 'delete_*': 'require-approval', list_issues: 'allow' },
      classOverrides: { list_issues: 'read' },
    },
  },
}

async function writePolicyFile(dir: string, content: unknown): Promise<string> {
  const path = join(dir, 'policy.json')
  await writeFile(path, JSON.stringify(content), 'utf8')
  return path
}

describe('runPolicyValidate', () => {
  test('valid policy at an explicit path: prints source path + OK, returns 0', async () => {
    const path = await writePolicyFile(cwd, VALID_POLICY)
    const io = fakeIo()

    const exitCode = await runPolicyValidate([path], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain(path)
    expect(io.out()).toContain('OK')
  })

  test('broken JSON: exit 1, error line prefixed with the source path', async () => {
    const path = join(cwd, 'broken.json')
    await writeFile(path, '{ not json', 'utf8')
    const io = fakeIo()

    const exitCode = await runPolicyValidate([path], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(path)
  })

  test('schema violation: exit 1, error lines prefixed with the source path', async () => {
    const path = await writePolicyFile(cwd, { version: 1, defaultDecision: 'not-a-real-outcome' })
    const io = fakeIo()

    const exitCode = await runPolicyValidate([path], io)

    expect(exitCode).toBe(1)
    const lines = io.err().trim().split('\n')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line.startsWith(path)).toBe(true)
    }
  })

  test('unrecognized key in a strictObject: exit 1, one error line per bad key', async () => {
    const path = await writePolicyFile(cwd, { version: 1, tols: {} })
    const io = fakeIo()

    const exitCode = await runPolicyValidate([path], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('tols')
  })

  test('default resolution with no policy file anywhere: disabled, lists the 4 searched locations, exit 1', async () => {
    const io = fakeIo()

    const exitCode = await runPolicyValidate([], io, { cwd, journalDir, env: {} })

    expect(exitCode).toBe(1)
    const err = io.err()
    expect(err).toContain('--policy')
    expect(err).toContain('MCP_JOURNAL_POLICY')
    expect(err).toContain(join(cwd, '.mcp-journal', 'policy.json'))
    expect(err).toContain(join(journalDir, 'policy.json'))
  })

  test('an explicit path that does not exist is a hard error, not "disabled"', async () => {
    const missing = join(cwd, 'nope.json')
    const io = fakeIo()

    const exitCode = await runPolicyValidate([missing], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(missing)
    expect(io.err()).not.toContain('no policy file found')
  })

  test('unknown flag: prints usage, returns 1', async () => {
    const io = fakeIo()

    const exitCode = await runPolicyValidate(['--bogus'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })
})

describe('runPolicyShow', () => {
  test('--json prints parseable JSON with defaults applied (approval.timeoutMs present)', async () => {
    const path = await writePolicyFile(cwd, VALID_POLICY)
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--policy', path, '--json'], io)

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(io.out())
    expect(parsed.sourcePath).toBe(path)
    expect(typeof parsed.policy.approval.timeoutMs).toBe('number')
    expect(parsed.policy.quarantine.enabled).toBe(true)
  })

  test('readable view prints the source path, top-level sections, and per-server rules', async () => {
    const path = await writePolicyFile(cwd, VALID_POLICY)
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--policy', path], io)

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out).toContain(path)
    expect(out).toContain('defaultDecision:')
    expect(out).toContain('quarantine:')
    expect(out).toContain('approval:')
    expect(out).toContain('github')
    expect(out).toContain('delete_*')
    expect(out).toContain('require-approval')
  })

  test('--server filters the readable view to only that server', async () => {
    const policy = {
      ...VALID_POLICY,
      servers: {
        ...VALID_POLICY.servers,
        gitlab: { defaultDecision: 'deny' },
      },
    }
    const path = await writePolicyFile(cwd, policy)
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--policy', path, '--server', 'github'], io)

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out).toContain('github')
    expect(out).not.toContain('gitlab')
  })

  test('unknown --server exits 1 and lists the known server names', async () => {
    const path = await writePolicyFile(cwd, VALID_POLICY)
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--policy', path, '--server', 'does-not-exist'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('does-not-exist')
    expect(io.err()).toContain('github')
  })

  test('a control character in --server is neutralized in the error output', async () => {
    const path = await writePolicyFile(cwd, VALID_POLICY)
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--policy', path, '--server', 'evil\x1b[2Jserver'], io)

    expect(exitCode).toBe(1)
    const err = io.err()
    const withoutLineBreaks = err.replace(/\n/g, '')
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x1f\x7f]/.test(withoutLineBreaks)).toBe(false)
    expect(err).toContain('evil?[2Jserver')
  })

  test('disabled policy (no file found anywhere): message + exit 1', async () => {
    const io = fakeIo()

    const exitCode = await runPolicyShow([], io, { cwd, journalDir, env: {} })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('no policy file found')
  })

  test('the searched-locations list labels each candidate and never repeats a path', async () => {
    // Manual M4 smoke, finding 4: run from inside the journal directory and the
    // list read `…/.mcp-journal/.mcp-journal/policy.json`. That path was
    // correct — the project-level candidate is resolved against the cwd — but
    // the output gave an operator no way to tell which line was which, so it
    // read as a bug. Label the two, and collapse them when they coincide.
    const io = fakeIo()

    await runPolicyShow([], io, { cwd: journalDir, journalDir, env: {} })

    const err = io.err()
    expect(err).toContain('project-level')
    expect(err).toContain('home-level')
    const policyLines = err.split('\n').filter((line) => line.includes('policy.json'))
    expect(new Set(policyLines.map((line) => line.trim())).size).toBe(policyLines.length)
  })

  test('the two candidates are listed separately when they are different paths', async () => {
    const io = fakeIo()

    await runPolicyShow([], io, { cwd, journalDir, env: {} })

    const err = io.err()
    expect(err).toContain(join(cwd, '.mcp-journal', 'policy.json'))
    expect(err).toContain(join(journalDir, 'policy.json'))
  })

  test('broken policy file: exit 1, error prefixed with source path', async () => {
    const path = join(cwd, 'broken.json')
    await writeFile(path, '{ not json', 'utf8')
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--policy', path], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain(path)
  })

  test('a server with no explicit rules still gets a readable section', async () => {
    const policy = { version: 1, defaultDecision: 'allow', servers: { bare: {} } }
    const path = await writePolicyFile(cwd, policy)
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--policy', path], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('bare')
  })

  test('unknown flag: prints usage, returns 1', async () => {
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--bogus'], io)

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
  })

  test('project-level policy file is picked up via default resolution (cwd)', async () => {
    await mkdir(join(cwd, '.mcp-journal'), { recursive: true })
    await writePolicyFile(join(cwd, '.mcp-journal'), VALID_POLICY)
    const io = fakeIo()

    const exitCode = await runPolicyShow([], io, { cwd, journalDir, env: {} })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('github')
  })
})

/**
 * `policy show --entry-point <name>` answers the question the manual smoke of
 * 2026-08-10 could not: which file does THIS entry point really load. The
 * answer must be the same one the entry point itself would reach (ADR-0005),
 * which is why every test here asserts a path, not a description.
 */
describe('runPolicyShow --entry-point', () => {
  /** Project policy, state-directory policy and `$MCP_JOURNAL_POLICY` all present at once. */
  async function writeAllThreeSources(): Promise<{
    projectPath: string
    statePath: string
    envPath: string
  }> {
    await mkdir(join(cwd, '.mcp-journal'), { recursive: true })
    const projectPath = await writePolicyFile(join(cwd, '.mcp-journal'), {
      version: 1,
      servers: { 'project-server': {} },
    })
    const statePath = await writePolicyFile(journalDir, {
      version: 1,
      servers: { 'state-server': {} },
    })
    const envPath = join(cwd, 'env-policy.json')
    await writeFile(envPath, JSON.stringify({ version: 1, servers: { 'env-server': {} } }), 'utf8')
    return { projectPath, statePath, envPath }
  }

  test('an unknown entry point name explains the expected values instead of generic usage', async () => {
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--entry-point', 'typoo'], io, { cwd, journalDir, env: {} })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('expected one of connect, wrap, serve, ui')
  })

  test('connect: prints the state-directory policy, ignoring env and project sources', async () => {
    const { statePath, envPath } = await writeAllThreeSources()
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--entry-point', 'connect'], io, {
      cwd,
      journalDir,
      env: { MCP_JOURNAL_POLICY: envPath },
    })

    expect(exitCode).toBe(0)
    const out = io.out()
    expect(out).toContain(statePath)
    expect(out).toContain('state-server')
    expect(out).not.toContain('project-server')
    expect(out).not.toContain('env-server')
  })

  test('connect: the printed source is the one a real connect session loads', async () => {
    const { envPath } = await writeAllThreeSources()
    const showIo = fakeIo()
    const connectIo = fakeIo()

    await runPolicyShow(['--entry-point', 'connect'], showIo, {
      cwd,
      journalDir,
      env: { MCP_JOURNAL_POLICY: envPath },
    })
    // The same resolution, driven through the entry point itself: its stderr
    // line is the only place a connect session names the file it loaded.
    const outcome = await resolveConnectPolicy({
      io: connectIo,
      journalDir,
      env: { MCP_JOURNAL_POLICY: envPath },
      cwd,
    })

    expect(outcome.status).toBe('resolved')
    const loadedBy = /policy: loaded from (.+)\n/.exec(connectIo.err())?.[1]
    expect(loadedBy).toBeDefined()
    expect(showIo.out()).toContain(`source: ${loadedBy}`)
  })

  test('connect: names the entry point and its trust class', async () => {
    await writeAllThreeSources()
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--entry-point', 'connect'], io, { cwd, journalDir, env: {} })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('connect')
    expect(io.out()).toContain('agent-launched')
  })

  test('serve: keeps the four-source order, so the project file wins', async () => {
    const { projectPath } = await writeAllThreeSources()
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--entry-point', 'serve'], io, { cwd, journalDir, env: {} })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain(projectPath)
    expect(io.out()).toContain('project-server')
    expect(io.out()).toContain('operator-launched')
  })

  test('serve and connect disagree on the same host, and each says so explicitly', async () => {
    const { projectPath, statePath } = await writeAllThreeSources()
    const serveIo = fakeIo()
    const connectIo = fakeIo()

    await runPolicyShow(['--entry-point', 'serve'], serveIo, { cwd, journalDir, env: {} })
    await runPolicyShow(['--entry-point', 'connect'], connectIo, { cwd, journalDir, env: {} })

    expect(serveIo.out()).toContain(projectPath)
    expect(connectIo.out()).toContain(statePath)
  })

  test('connect: an ignored source that exists gets exactly one note on stderr', async () => {
    const { envPath } = await writeAllThreeSources()
    const io = fakeIo()

    await runPolicyShow(['--entry-point', 'connect'], io, {
      cwd,
      journalDir,
      env: { MCP_JOURNAL_POLICY: envPath },
    })

    const noteLines = io.err().split('\n').filter((line) => line.includes('ignoring'))
    expect(noteLines).toHaveLength(2)
    expect(io.err()).toContain('$MCP_JOURNAL_POLICY')
    expect(io.err()).toContain(join(cwd, '.mcp-journal', 'policy.json'))
  })

  test('connect: --policy is refused, with the operator location in the message', async () => {
    const { envPath } = await writeAllThreeSources()
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--entry-point', 'connect', '--policy', envPath], io, {
      cwd,
      journalDir,
      env: {},
    })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('refusing --policy')
    expect(io.err()).toContain(join(journalDir, 'policy.json'))
    expect(io.out()).toBe('')
  })

  test('serve: --policy is honored (operator-launched entry)', async () => {
    const { envPath } = await writeAllThreeSources()
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--entry-point', 'serve', '--policy', envPath], io, {
      cwd,
      journalDir,
      env: {},
    })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain('env-server')
  })

  test('connect with no policy anywhere: lists only the state-directory locations', async () => {
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--entry-point', 'connect'], io, { cwd, journalDir, env: {} })

    expect(exitCode).toBe(1)
    const err = io.err()
    expect(err).toContain('no policy file found')
    expect(err).toContain(join(journalDir, 'policy.json'))
    expect(err).not.toContain(join(cwd, '.mcp-journal', 'policy.json'))
  })

  test('an unknown entry point is a usage error, not a silent default', async () => {
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--entry-point', 'daemon'], io, { cwd, journalDir, env: {} })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Usage')
    expect(io.err()).toContain('connect')
  })

  test('--json carries the entry point and its trust class', async () => {
    const { statePath } = await writeAllThreeSources()
    const io = fakeIo()

    const exitCode = await runPolicyShow(['--entry-point', 'connect', '--json'], io, {
      cwd,
      journalDir,
      env: {},
    })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(io.out())
    expect(parsed.sourcePath).toBe(statePath)
    expect(parsed.entryPoint).toBe('connect')
    expect(parsed.trustClass).toBe('agent-launched')
  })

  test('without --entry-point the output is unchanged (no entry-point line)', async () => {
    const { projectPath } = await writeAllThreeSources()
    const io = fakeIo()

    const exitCode = await runPolicyShow([], io, { cwd, journalDir, env: {} })

    expect(exitCode).toBe(0)
    expect(io.out()).toContain(projectPath)
    expect(io.out()).not.toContain('trust class')
  })
})
