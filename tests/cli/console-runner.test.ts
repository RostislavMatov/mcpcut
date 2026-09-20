import { describe, expect, test } from 'vitest'
import { createConsoleRunner } from '../../src/cli/console-runner.js'
import type { DispatchOptions } from '../../src/cli/dispatch-types.js'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'

/**
 * `createConsoleRunner` (ADR-0014, wave 1): the composition that turns one
 * console-API run request into a call of the SAME `dispatch` the local
 * console uses, with the bearer folded into the environment the way
 * `src/tui/session-env.ts` already does for it, and the request's `stdin`
 * wired the same way a typed secret is.
 */

function io(): { stdout: string[]; stderr: string[]; io: { stdout: { write(c: string): boolean }; stderr: { write(c: string): boolean } } } {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (c: string) => (stdout.push(c), true) },
      stderr: { write: (c: string) => (stderr.push(c), true) },
    },
  }
}

describe('createConsoleRunner', () => {
  test('dispatches the request argv through the injected dispatch', async () => {
    let seenArgv: readonly string[] | undefined
    const runner = createConsoleRunner({
      dispatch: async (argv) => {
        seenArgv = argv
        return 0
      },
    })

    const code = await runner({ argv: ['status'], token: 'mcpa_x' }, io().io)

    expect(seenArgv).toEqual(['status'])
    expect(code).toBe(0)
  })

  test('the bearer becomes MCP_ADMIN_TOKEN in every session-env seam, never in argv', async () => {
    let seenOptions: DispatchOptions | undefined
    const runner = createConsoleRunner({
      dispatch: async (_argv, _io, opts) => {
        seenOptions = opts
        return 0
      },
    })

    await runner({ argv: ['agent', 'list'], token: 'mcpa_the-bearer' }, io().io)

    expect(seenOptions?.agent?.env?.[ADMIN_TOKEN_ENV_VAR]).toBe('mcpa_the-bearer')
    expect(seenOptions?.server?.env?.[ADMIN_TOKEN_ENV_VAR]).toBe('mcpa_the-bearer')
  })

  test('a request with stdin wires vault.readSecretInput to resolve it, once', async () => {
    let seenOptions: DispatchOptions | undefined
    const runner = createConsoleRunner({
      dispatch: async (_argv, _io, opts) => {
        seenOptions = opts
        return 0
      },
    })

    await runner({ argv: ['vault', 'set', 'k'], stdin: 'the-secret-value', token: 'mcpa_x' }, io().io)

    await expect(seenOptions?.vault?.readSecretInput?.()).resolves.toBe('the-secret-value')
  })

  test('a request with no stdin refuses to read a secret, rather than falling back to the daemon stdin', async () => {
    let seenOptions: DispatchOptions | undefined
    const runner = createConsoleRunner({
      dispatch: async (_argv, _io, opts) => {
        seenOptions = opts
        return 0
      },
    })

    await runner({ argv: ['vault', 'list'], token: 'mcpa_x' }, io().io)

    await expect(seenOptions?.vault?.readSecretInput?.()).rejects.toThrow(/no secret input/)
  })

  test('base dispatch options are preserved alongside the per-request env', async () => {
    let seenOptions: DispatchOptions | undefined
    const runner = createConsoleRunner({
      dispatch: async (_argv, _io, opts) => {
        seenOptions = opts
        return 0
      },
      baseOptions: { journalDir: '/tmp/whatever-journal' },
    })

    await runner({ argv: ['status'], token: 'mcpa_x' }, io().io)

    expect(seenOptions?.journalDir).toBe('/tmp/whatever-journal')
  })

  test('the runner hands back whatever exit code dispatch answers', async () => {
    const runner = createConsoleRunner({ dispatch: async () => 3 })

    const code = await runner({ argv: ['status'], token: 'mcpa_x' }, io().io)

    expect(code).toBe(3)
  })
})
