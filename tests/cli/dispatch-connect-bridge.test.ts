import { PassThrough } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { dispatch, type CliIo } from '../../src/cli.js'
import { CONNECT_USAGE, AGENT_TOKEN_ENV_VAR } from '../../src/cli/connect-constants.js'
import { USAGE } from '../../src/cli/usage.js'
import type { DataDirResolution } from '../../src/setup/data-dir.js'

/**
 * `connect --url` routes ahead of the broken-config gate (plan task 6).
 *
 * That is the whole claim of PRD phase 2: the bridge runs on a machine that
 * has no install at all — no data directory, no `config.json`, possibly no
 * `$HOME` — so it must be chosen before the gate that refuses every ordinary
 * command over an unusable config, exactly as `--remote` and `setup` are.
 */

function fakeIo(): CliIo & { out(): string; err(): string } {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

const BROKEN: DataDirResolution = {
  dataDir: '/home/op/.mcpcut/data',
  source: 'default',
  configPath: '/home/op/.mcpcut/config.json',
  problem: ['dataDir: dataDir must be an absolute path'],
}

describe('dispatch routes connect --url ahead of the install gate', () => {
  test('the bridge reaches its own refusal over an unusable config', async () => {
    const io = fakeIo()

    // A bad address: the cheapest path that proves the bridge's own code ran,
    // since the gate's refusal reads quite differently.
    const exitCode = await dispatch(['connect', '--url', 'ftp://plane.example'], io, {
      install: BROKEN,
      connectBridge: { env: {} },
    })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('--url')
    expect(io.err()).not.toContain('config.json')
  })

  test('it runs a whole session over an unusable config, and exits 0', async () => {
    const io = fakeIo()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    stdout.resume()
    let created = 0

    const done = dispatch(['connect', '--url', 'https://plane.example:8090'], io, {
      install: BROKEN,
      connectBridge: {
        env: { [AGENT_TOKEN_ENV_VAR]: 'mcpj_dispatch-test' },
        stdin,
        stdout,
        createClient: () => {
          created += 1
          return {
            source: {
              onMessage: () => undefined,
              onError: () => undefined,
              onEnd: () => undefined,
              dispose: () => undefined,
            },
            sink: { write: () => Promise.resolve(), dispose: () => undefined },
            close: () => Promise.resolve(),
          }
        },
      },
    })
    stdin.end()

    expect(await done).toBe(0)
    expect(created).toBe(1)
  })

  test('the LOCAL form still hits the gate over the same config', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['connect', 'files', '--agent', 'reader'], io, {
      install: BROKEN,
      connectBridge: { env: {} },
    })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('config.json')
  })

  test('a bare connect is still the local form', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['connect'], io, { install: BROKEN })

    expect(exitCode).toBe(1)
    expect(io.err()).toContain('config.json')
  })
})

describe('both forms of connect are in the usage text', () => {
  test('the global block names the remote form and its flag', () => {
    expect(USAGE).toContain('mcpcut connect --url <address>')
    expect(USAGE).toContain('--allow-http')
  })

  test("connect's own usage names it too, so a refusal shows both forms", () => {
    expect(CONNECT_USAGE).toContain('--url <address>')
    expect(CONNECT_USAGE).toContain(AGENT_TOKEN_ENV_VAR)
  })
})
