import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import { probe } from '../../src/probe/engine.js'
import type { ResolveEnvRefsFn } from '../../src/proxy/server-env.js'
import { serverRecordSchema, type ServerRecord } from '../../src/registry/schema.js'

/**
 * RV6: the status probe speaks BOTH revisions. A server that speaks only
 * 2026-07-28 refuses the handshake; the probe then asks a stamped `tools/list`
 * and reports the server alive via `tools/list` — otherwise a member that
 * works in a pool would show `error` on `/servers`, and the registration probe
 * would never feed the inventory.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const MODERN = join(__dirname, '../fixtures/pool-modern-server.mjs')
const OLD = join(__dirname, '../fixtures/pool-server.mjs')
const HTTP_STATELESS = join(__dirname, '../fixtures/http-server-stateless.mjs')

/** Answers every request with a JSON-RPC error: a server that refuses both ways. */
const REFUSE_EVERYTHING =
  "require('node:readline').createInterface({input:process.stdin}).on('line',(l)=>{" +
  "const m=JSON.parse(l);if(m.id!==undefined)process.stdout.write(JSON.stringify(" +
  "{jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'no'}})+'\\n')})"

const resolvePassthrough: ResolveEnvRefsFn = (record) =>
  Promise.resolve({ status: 'resolved', values: { ...record } })

const deps = {
  processEnv: process.env,
  resolveRefs: resolvePassthrough,
  timeoutMs: 5_000,
  childExitGraceMs: 50,
  killEscalationMs: 50,
}

const spawned: ChildProcess[] = []
afterAll(() => {
  for (const child of spawned) child.kill('SIGKILL')
})

function stdio(args: readonly string[]): ServerRecord {
  return serverRecordSchema.parse({ name: 'target', transport: 'stdio', command: process.execPath, args: [...args] })
}

function http(url: string, protocol: 'auto' | 'stateless'): ServerRecord {
  return serverRecordSchema.parse({ name: 'target', transport: 'http', url, protocol })
}

async function strictHttpServer(): Promise<string> {
  const child = spawn(process.execPath, [HTTP_STATELESS], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, STRICT: '1', STRICT_TOOLS: 'echo,fetch' },
  })
  spawned.push(child)
  const port = await new Promise<number>((resolve, reject) => {
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
      const newline = out.indexOf('\n')
      if (newline !== -1) resolve(Number(out.slice(0, newline)))
    })
    child.once('error', reject)
  })
  return `http://127.0.0.1:${port}/mcp`
}

describe('the probe on a server of the 2026-07-28 revision', () => {
  test('stdio: refused handshake, then alive via a stamped tools/list, with the tools', async () => {
    // Act
    const result = await probe(stdio([MODERN, 'echo', 'query']), { ...deps, withTools: true })

    // Assert
    expect(result).toMatchObject({ status: 'alive', probedVia: 'tools/list' })
    if (result.status !== 'alive') return
    expect(result.tools?.map((tool) => tool.name)).toEqual(['echo', 'query'])
    expect(result.initializeLatencyMs).toBeGreaterThan(0)
  })

  test('HTTP `stateless`: a stamped tools/list the server accepts', async () => {
    // Arrange
    const url = await strictHttpServer()

    // Act
    const result = await probe(http(url, 'stateless'), { ...deps, withTools: true })

    // Assert
    expect(result).toMatchObject({ status: 'alive', probedVia: 'tools/list' })
    if (result.status !== 'alive') return
    expect(result.tools?.map((tool) => tool.name)).toEqual(['echo', 'fetch'])
  })

  test('HTTP `auto`: the 400 on initialize is an answer to fall back from', async () => {
    // Arrange
    const url = await strictHttpServer()

    // Act
    const result = await probe(http(url, 'auto'), deps)

    // Assert
    expect(result).toMatchObject({ status: 'alive', probedVia: 'tools/list' })
  })
})

describe('the probe on an older server', () => {
  test('still proves it alive via initialize', async () => {
    const result = await probe(stdio([OLD, 'echo']), deps)

    expect(result).toMatchObject({ status: 'alive', probedVia: 'initialize' })
  })

  test('a server that refuses both ways is an error, reported against initialize', async () => {
    const result = await probe(stdio(['-e', REFUSE_EVERYTHING]), deps)

    expect(result).toEqual({
      status: 'error',
      message: 'the server answered initialize with JSON-RPC error code -32000',
    })
  })
})
