import { describe, expect, test } from 'vitest'
import { dispatch, type CliIo } from '../../src/cli.js'
import { PRODUCT_VERSION } from '../../src/brand.js'
import { USAGE } from '../../src/cli/usage.js'
import type { DataDirResolution } from '../../src/setup/data-dir.js'

/**
 * `mcpcut --version` is the first thing people type after an install; until
 * 0.1.1 it answered `Unknown command` with the whole usage on stderr (found
 * checking the published 0.1.0, 2026-09-25). It prints one line on stdout and
 * works even over a broken install config, like `--help`: saying which build
 * is installed is how an operator starts reporting that config problem.
 */

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

const broken: DataDirResolution = {
  dataDir: '/home/op/.mcpcut/data',
  source: 'default',
  configPath: '/home/op/.mcpcut/config.json',
  problem: ['dataDir: dataDir must be an absolute path'],
}

describe('dispatch: --version', () => {
  test.each(['--version', '-v'])('%s prints "mcpcut <version>" on stdout and exits 0', async (flag) => {
    const io = fakeIo()

    const exitCode = await dispatch([flag], io)

    expect(exitCode).toBe(0)
    expect(io.out()).toBe(`mcpcut ${PRODUCT_VERSION}\n`)
    expect(io.err()).toBe('')
  })

  test('answers over a broken install config, like --help', async () => {
    const io = fakeIo()

    const exitCode = await dispatch(['--version'], io, { install: broken })

    expect(exitCode).toBe(0)
    expect(io.out()).toBe(`mcpcut ${PRODUCT_VERSION}\n`)
    expect(io.err()).toBe('')
  })

  test('the usage names it', () => {
    expect(USAGE).toContain('mcpcut --version')
  })
})
