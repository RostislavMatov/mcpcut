import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runVault, type VaultCmdDeps } from '../../src/cli/vault-cmd.js'

let journalDir: string

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcp-journal-vault-cmd-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

/** Captures stdout/stderr writes for assertions instead of touching the real streams. */
function fakeIo(): {
  stdout: { write: (chunk: string) => void }
  stderr: { write: (chunk: string) => void }
  out: () => string
  err: () => string
} {
  const outChunks: string[] = []
  const errChunks: string[] = []
  return {
    stdout: { write: (chunk: string) => outChunks.push(chunk) },
    stderr: { write: (chunk: string) => errChunks.push(chunk) },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  }
}

/** Deps with a fake stdin: `vault set` must never read the value from argv. */
function deps(stdinValue = ''): VaultCmdDeps {
  return { journalDir, readSecretInput: async () => stdinValue }
}

describe('dispatch', () => {
  test('missing subcommand → usage on stderr, exit 1', async () => {
    const io = fakeIo()

    const code = await runVault([], io, deps())

    expect(code).toBe(1)
    expect(io.err()).toContain('Usage')
  })

  test('unknown subcommand → usage, exit 1', async () => {
    const io = fakeIo()

    const code = await runVault(['frobnicate'], io, deps())

    expect(code).toBe(1)
    expect(io.err()).toContain('frobnicate')
  })

  test('there is deliberately no "vault get": it is rejected as unknown', async () => {
    const io = fakeIo()
    await runVault(['init'], fakeIo(), deps())
    await runVault(['set', 'a'], fakeIo(), deps('value'))

    const code = await runVault(['get', 'a'], io, deps())

    expect(code).toBe(1)
    expect(io.out()).not.toContain('value')
  })
})

describe('vault init', () => {
  test('initializes and reports the key location, exit 0', async () => {
    const io = fakeIo()

    const code = await runVault(['init'], io, deps())

    expect(code).toBe(0)
    expect(io.out()).toContain('vault.key')
  })

  test('second init → exit 1 with already-initialized message', async () => {
    await runVault(['init'], fakeIo(), deps())
    const io = fakeIo()

    const code = await runVault(['init'], io, deps())

    expect(code).toBe(1)
    expect(io.err()).toContain('already initialized')
  })
})

describe('vault set', () => {
  test('reads the value from injected stdin, exit 0, never echoes the value', async () => {
    await runVault(['init'], fakeIo(), deps())
    const io = fakeIo()

    const code = await runVault(['set', 'github-pat'], io, deps('tok-value-xyz'))

    expect(code).toBe(0)
    expect(io.out()).toContain('github-pat')
    expect(io.out()).not.toContain('tok-value-xyz')
    expect(io.err()).not.toContain('tok-value-xyz')
  })

  test('missing name → usage, exit 1', async () => {
    const io = fakeIo()

    const code = await runVault(['set'], io, deps('v'))

    expect(code).toBe(1)
    expect(io.err()).toContain('Usage')
  })

  test('empty stdin → exit 1 with a clear error', async () => {
    await runVault(['init'], fakeIo(), deps())
    const io = fakeIo()

    const code = await runVault(['set', 'a'], io, deps(''))

    expect(code).toBe(1)
    expect(io.err()).toContain('empty')
  })

  test('invalid name → exit 1 naming the constraint', async () => {
    await runVault(['init'], fakeIo(), deps())
    const io = fakeIo()

    const code = await runVault(['set', 'Bad_Name'], io, deps('v'))

    expect(code).toBe(1)
    expect(io.err()).toContain('name')
  })

  test('uninitialized vault → exit 1 with a "vault init" hint', async () => {
    const io = fakeIo()

    const code = await runVault(['set', 'a'], io, deps('v'))

    expect(code).toBe(1)
    expect(io.err()).toContain('vault init')
  })
})

describe('vault list', () => {
  test('empty vault → friendly empty message, exit 0', async () => {
    await runVault(['init'], fakeIo(), deps())
    const io = fakeIo()

    const code = await runVault(['list'], io, deps())

    expect(code).toBe(0)
    expect(io.out()).toContain('no secrets')
  })

  test('lists names with created/updated dates, never values', async () => {
    const now = (): number => 1_700_000_000_000
    await runVault(['init'], fakeIo(), { ...deps(), now })
    await runVault(['set', 'github-pat'], fakeIo(), { ...deps('tok-value-xyz'), now })
    const io = fakeIo()

    const code = await runVault(['list'], io, { ...deps(), now })

    expect(code).toBe(0)
    expect(io.out()).toContain('github-pat')
    expect(io.out()).toContain(new Date(1_700_000_000_000).toISOString())
    expect(io.out()).not.toContain('tok-value-xyz')
  })

  test('uninitialized vault → exit 1 with a "vault init" hint', async () => {
    const io = fakeIo()

    const code = await runVault(['list'], io, deps())

    expect(code).toBe(1)
    expect(io.err()).toContain('vault init')
  })
})

describe('vault remove', () => {
  test('removes an existing secret, exit 0', async () => {
    await runVault(['init'], fakeIo(), deps())
    await runVault(['set', 'a'], fakeIo(), deps('v'))
    const io = fakeIo()

    const code = await runVault(['remove', 'a'], io, deps())

    expect(code).toBe(0)
    const listIo = fakeIo()
    await runVault(['list'], listIo, deps())
    expect(listIo.out()).not.toContain('"a"')
  })

  test('absent secret → exit 1 with not-found message', async () => {
    await runVault(['init'], fakeIo(), deps())
    const io = fakeIo()

    const code = await runVault(['remove', 'missing'], io, deps())

    expect(code).toBe(1)
    expect(io.err()).toContain('missing')
  })

  test('missing name → usage, exit 1', async () => {
    const io = fakeIo()

    const code = await runVault(['remove'], io, deps())

    expect(code).toBe(1)
    expect(io.err()).toContain('Usage')
  })
})

describe('vault rekey', () => {
  test('rekeys an initialized vault, exit 0, secrets survive', async () => {
    await runVault(['init'], fakeIo(), deps())
    await runVault(['set', 'a'], fakeIo(), deps('keep-me'))
    const io = fakeIo()

    const code = await runVault(['rekey'], io, deps())

    expect(code).toBe(0)
    const listIo = fakeIo()
    await runVault(['list'], listIo, deps())
    expect(listIo.out()).toContain('a')
  })

  test('uninitialized vault → exit 1 with a "vault init" hint', async () => {
    const io = fakeIo()

    const code = await runVault(['rekey'], io, deps())

    expect(code).toBe(1)
    expect(io.err()).toContain('vault init')
  })
})
