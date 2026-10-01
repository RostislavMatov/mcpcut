import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { runWrapCommand } from '../../src/cli/wrap-cmd.js'

/**
 * First-minute output of `wrap` (0.2.4, stranger run of 0.2.3): the end of a
 * session names the command that reads it, the "no policy" line says where a
 * policy is picked up, a broken policy file says what to do in one line, and
 * the missing `-- <cmd>` usage carries a ready example.
 */

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-wrap-first-minute-'))
  vi.stubEnv('npm_command', '')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function fakeIo(): { stderr: { write: (chunk: string) => void }; err: () => string } {
  const chunks: string[] = []
  return { stderr: { write: (chunk: string) => chunks.push(chunk) }, err: () => chunks.join('') }
}

/** A real Writable (the proxy attaches listeners to it) that remembers what it was given. */
function streamIo(): { stream: PassThrough; err: () => string } {
  const stream = new PassThrough()
  const chunks: string[] = []
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
  return { stream, err: () => chunks.join('') }
}

const LOAD_OPTS = (): { cwd: string; journalDir: string; env: NodeJS.ProcessEnv } => ({
  cwd: dir,
  journalDir: dir,
  env: {},
})

describe('wrap: end of session', () => {
  test('names the session once, with the command that shows it', async () => {
    const io = fakeIo()
    const clientStderr = streamIo()

    const exitCode = await runWrapCommand(['--no-policy', '--', process.execPath, '-e', 'process.exit(0)'], io, {
      runWrap: { dir, sessionId: '01TESTSESSIONID', stderr: clientStderr.stream },
    })

    expect(exitCode).toBe(0)
    const lines = clientStderr.err().split('\n').filter((line) => line.includes('journaled'))
    expect(lines).toEqual(['session 01TESTSESSIONID journaled: mcpcut show 01TESTSESSIONID'])
  })

  test('uses the npx form when started through npx', async () => {
    vi.stubEnv('npm_command', 'exec')
    const io = fakeIo()
    const clientStderr = streamIo()

    await runWrapCommand(['--no-policy', '--', process.execPath, '-e', 'process.exit(0)'], io, {
      runWrap: { dir, sessionId: '01TESTSESSIONID', stderr: clientStderr.stream },
    })

    expect(clientStderr.err()).toMatch(/session 01TESTSESSIONID journaled: npx -y mcpcut@\S+ show 01TESTSESSIONID\n/)
  })
})

describe('wrap: no policy found', () => {
  test('keeps the old prefix and names where a policy is picked up and --policy', async () => {
    const io = fakeIo()

    await runWrapCommand(['--', process.execPath, '-e', 'process.exit(0)'], io, {
      runWrap: { dir },
      loadPolicy: LOAD_OPTS(),
    })

    const text = io.err()
    expect(text).toContain('policy: none found, journaling only\n')
    expect(text).toContain(join(dir, '.mcpcut-project', 'policy.json'))
    expect(text).toContain('--policy <path>')
  })
})

describe('wrap: policy file errors say what to do, with the path once', () => {
  test('a path that does not exist', async () => {
    const io = fakeIo()
    const missing = join(dir, 'polcy.json')

    const exitCode = await runWrapCommand(['--policy', missing, '--', 'node'], io, {
      runWrap: { dir },
      loadPolicy: LOAD_OPTS(),
    })

    expect(exitCode).toBe(1)
    expect(io.err()).toBe(`${missing}: policy file not found. Check the path.\n`)
  })

  test('invalid JSON points at policy validate', async () => {
    const io = fakeIo()
    const broken = join(dir, 'broken.json')
    await writeFile(broken, '{', 'utf8')

    const exitCode = await runWrapCommand(['--policy', broken, '--', 'node'], io, {
      runWrap: { dir },
      loadPolicy: LOAD_OPTS(),
    })

    expect(exitCode).toBe(1)
    const text = io.err()
    expect(text.split('\n').filter(Boolean)).toHaveLength(1)
    expect(text.split(broken).length - 1).toBe(2)
    expect(text).toMatch(/^.*broken\.json: invalid JSON: .*\. Check it: mcpcut policy validate .*broken\.json\n$/)
  })

  test('a schema error keeps its own line without a hint', async () => {
    const io = fakeIo()
    const bad = join(dir, 'bad.json')
    await writeFile(bad, JSON.stringify({ version: 1, defaultDecision: 'maybe' }), 'utf8')

    await runWrapCommand(['--policy', bad, '--', 'node'], io, { runWrap: { dir }, loadPolicy: LOAD_OPTS() })

    expect(io.err()).toContain('defaultDecision: Invalid option')
    expect(io.err()).not.toContain('Check it')
  })
})

describe('wrap: missing "-- <cmd>"', () => {
  test('usage carries a ready example with the real directory', async () => {
    const io = fakeIo()
    const spaced = join(dir, 'my project')

    const exitCode = await runWrapCommand([], io, { loadPolicy: { cwd: spaced } })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('Missing "-- <cmd>" in wrap command.')
    expect(io.err()).toContain(
      `Example: mcpcut wrap --server fs -- npx -y @modelcontextprotocol/server-filesystem '${spaced}'`,
    )
  })
})
