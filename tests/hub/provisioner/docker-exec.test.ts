import { describe, expect, test } from 'vitest'
import { EXEC_OUTPUT_CAP_BYTES } from '../../../hub/src/provisioner/docker.js'
import { SHORT_TIMEOUT_MS, dockerErrorOf, runningContainer, useFakeDocker } from './docker-harness.js'

const ctx = useFakeDocker()
const TOKEN = 'mcpa_0123456789abcdefghijklmnopqrstuvwxyzABCDEF'
const OWNER_LINE = `{"admin":"alice","role":"owner","token":"${TOKEN}"}\n`

describe('exec', () => {
  test('runs argv as given, without a shell, and returns demuxed stdout, stderr and the exit code', async () => {
    // Arrange
    const client = ctx.client()
    const id = await runningContainer(client)
    const seen: unknown[] = []
    ctx.fake().onExec((container, argv, call) => {
      seen.push({ container: container.name, argv, call })
      return { exitCode: 0, stdout: OWNER_LINE, stderr: 'warning: shown once\n' }
    })

    // Act
    const result = await client.exec(id, ['mcpcut', 'admin', 'add', 'alice', '--role', 'owner', '--json'], {
      user: 'node',
      env: { MCPCUT_DATA_DIR: '/data' },
    })

    // Assert
    expect(result).toEqual({
      exitCode: 0,
      stdout: OWNER_LINE,
      stderr: 'warning: shown once\n',
      truncated: { stdout: false, stderr: false },
    })
    expect(seen).toEqual([
      {
        container: 'mcpcut-t-alice',
        argv: ['mcpcut', 'admin', 'add', 'alice', '--role', 'owner', '--json'],
        call: { user: 'node', env: ['MCPCUT_DATA_DIR=/data'] },
      },
    ])
  })

  test('the exec is created attached, without a TTY or stdin, and started non-detached without Upgrade', async () => {
    const client = ctx.client()
    const id = await runningContainer(client)

    await client.exec(id, ['true'], {})

    const calls = ctx.fake().calls()
    expect(calls.find((call) => call.route === 'POST /containers/{id}/exec')?.body).toEqual({
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: ['true'],
    })
    expect(calls.find((call) => call.route === 'POST /exec/{id}/start')?.body).toEqual({ Detach: false, Tty: false })
    expect(calls.at(-1)?.route).toBe('GET /exec/{id}/json')
  })

  test.each([1, 3, 8, 11])('frames cut into %i-byte socket writes still demux (and several frames per stream)', async (chunkSize) => {
    const client = ctx.client()
    const id = await runningContainer(client)
    ctx.fake().onExec(() => ({ exitCode: 3, stdout: OWNER_LINE, stderr: 'boom', frameSize: 7, chunkSize }))

    const result = await client.exec(id, ['x'], {})

    expect(result.stdout).toBe(OWNER_LINE)
    expect(result.stderr).toBe('boom')
    expect(result.exitCode).toBe(3)
  })

  test('a non-zero exit code is a result, not an error', async () => {
    const client = ctx.client()
    const id = await runningContainer(client)
    ctx.fake().onExec(() => ({ exitCode: 127, stderr: 'not found' }))

    expect((await client.exec(id, ['nope'], {})).exitCode).toBe(127)
  })

  test('each stream is capped at 64 KiB and marked truncated; the rest is drained', async () => {
    const client = ctx.client()
    const id = await runningContainer(client)
    const big = 'a'.repeat(EXEC_OUTPUT_CAP_BYTES + 10_000)
    ctx.fake().onExec(() => ({ exitCode: 0, stdout: big, stderr: 'small', frameSize: 4096, chunkSize: 16_384 }))

    const result = await client.exec(id, ['x'], {})

    expect(EXEC_OUTPUT_CAP_BYTES).toBe(64 * 1024)
    expect(result.stdout).toHaveLength(EXEC_OUTPUT_CAP_BYTES)
    expect(result.truncated).toEqual({ stdout: true, stderr: false })
    expect(result.stderr).toBe('small')
  })

  test('waits for the exit code when the daemon still reports Running right after the stream', async () => {
    const client = ctx.client()
    const id = await runningContainer(client)
    ctx.fake().onExec(() => ({ exitCode: 5, runningInspections: 3 }))

    const result = await client.exec(id, ['x'], {})

    expect(result.exitCode).toBe(5)
    expect(ctx.fake().calls().filter((call) => call.route === 'GET /exec/{id}/json')).toHaveLength(4)
  })

  test('an exit code that never appears is a bad-response error', async () => {
    const client = ctx.client()
    const id = await runningContainer(client)
    ctx.fake().onExec(() => ({ exitCode: 0, runningInspections: 1_000 }))

    const error = await dockerErrorOf(client.exec(id, ['x'], {}))

    expect(error.failure).toBe('bad-response')
  })

  test('a stream that is not framed is refused without quoting it', async () => {
    const client = ctx.client()
    const id = await runningContainer(client)
    ctx.fake().onExec(() => ({ exitCode: 0, rawStream: Buffer.from(`token ${TOKEN}`) }))

    const error = await dockerErrorOf(client.exec(id, ['x'], {}))

    expect(error.failure).toBe('bad-response')
    expect(error.message).not.toContain(TOKEN)
  })

  test('a stream cut mid-frame is refused without quoting what arrived', async () => {
    const client = ctx.client()
    const id = await runningContainer(client)
    const header = Buffer.from([1, 0, 0, 0, 0, 0, 1, 0])
    ctx.fake().onExec(() => ({ exitCode: 0, rawStream: Buffer.concat([header, Buffer.from(TOKEN)]) }))

    const error = await dockerErrorOf(client.exec(id, ['x'], {}))

    expect(error.failure).toBe('bad-response')
    expect(error.message).not.toContain(TOKEN)
  })

  test('exec in a stopped container is 409; in a missing one notFound', async () => {
    const client = ctx.client()
    const { id } = await client.createContainer('stopped', { Image: 'img' })

    expect((await dockerErrorOf(client.exec(id, ['x'], {}))).status).toBe(409)
    expect((await dockerErrorOf(client.exec('ghost', ['x'], {}))).notFound).toBe(true)
  })

  test('a failed start answers with Docker’s message and no output', async () => {
    const client = ctx.client()
    const id = await runningContainer(client)
    ctx.fake().failNext('POST /exec/{id}/start', 500, 'OCI runtime exec failed: exec: "mcpcut": executable file not found')

    const error = await dockerErrorOf(client.exec(id, ['mcpcut'], {}))

    expect(error.status).toBe(500)
    expect(error.message).toContain('executable file not found')
  })

  test('the per-call timeout bounds a stream that never ends', async () => {
    const client = ctx.client()
    const id = await runningContainer(client)
    ctx.fake().hangNext('POST /exec/{id}/start')

    const error = await dockerErrorOf(client.exec(id, ['sleep', 'infinity'], { timeoutMs: SHORT_TIMEOUT_MS }))

    expect(error.failure).toBe('timeout')
    expect(error.status).toBeUndefined()
  })

  test.each([
    [[] as string[], /argv/],
    [['a\u0000b'], /argv/],
  ])('refuses argv %j before any call', async (argv, message) => {
    const client = ctx.client()

    await expect(client.exec('c1', argv, {})).rejects.toThrow(message)
    expect(ctx.fake().calls()).toEqual([])
  })

  test.each([
    [{ user: 'node; rm -rf /' }, /user/],
    [{ user: '' }, /user/],
    [{ timeoutMs: 0 }, /timeoutMs/],
    [{ timeoutMs: Number.POSITIVE_INFINITY }, /timeoutMs/],
  ])('refuses options %j before any call', async (options, message) => {
    await expect(ctx.client().exec('c1', ['x'], options)).rejects.toThrow(message)
    expect(ctx.fake().calls()).toEqual([])
  })

  test('accepts user as name, uid, and uid:gid', async () => {
    const client = ctx.client()
    const id = await runningContainer(client)

    for (const user of ['node', '1000', '1000:1000']) await client.exec(id, ['true'], { user })

    const users = ctx.fake().calls().filter((call) => call.route === 'POST /containers/{id}/exec').map((call) => (call.body as { User?: string }).User)
    expect(users).toEqual(['node', '1000', '1000:1000'])
  })

  test('refuses an env name that is not a variable name', async () => {
    await expect(ctx.client().exec('c1', ['x'], { env: { 'A=B': 'c' } })).rejects.toThrow(/env/)
    await expect(ctx.client().exec('c1', ['x'], { env: { A: 'b\u0000' } })).rejects.toThrow(/env/)
  })
})
