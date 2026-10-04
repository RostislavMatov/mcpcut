import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAdminStore } from '../../src/admin/store.js'
import { runServerList, runServerShow, type ServerCliOptions } from '../../src/cli/server-cmd.js'
import { createRegistryStore } from '../../src/registry/store.js'

let journalDir: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-server-builtin-'))
  const { token } = await createAdminStore({ journalDir }).createAdmin('root', 'owner')
  env = { MCP_ADMIN_TOKEN: token }
  await createRegistryStore(journalDir).addServer({ name: 'files', transport: 'builtin', kind: 'files' })
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

function fakeIo() {
  const out: string[] = []
  const err: string[] = []
  return {
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => err.push(chunk) },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

const opts = (): ServerCliOptions => ({
  journalDir,
  env,
  probes: { runProbe: async () => ({ status: 'alive', initializeLatencyMs: 1, probedVia: 'initialize' }) },
})

describe('server list / show: builtin files server', () => {
  test('list shows the built-in transport and a readable target', async () => {
    const io = fakeIo()
    expect(await runServerList([], io, opts())).toBe(0)
    expect(io.out()).toContain('builtin')
    expect(io.out()).toContain('built-in file server')
  })

  test('show prints the kind and says nothing is spawned, with the folder next step', async () => {
    const io = fakeIo()
    expect(await runServerShow(['files'], io, opts())).toBe(0)
    expect(io.out()).toContain('transport: builtin')
    expect(io.out()).toContain('kind: files')
    expect(io.out()).not.toContain('command:')
    expect(io.out()).not.toContain('url:')
    expect(io.out()).toContain('runs inside mcpcut')
  })
})
