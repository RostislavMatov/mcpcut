import { describe, expect, test } from 'vitest'
import { StdioServerRefusedError } from '../../src/tenant/errors.js'

/**
 * Tenant mode errors (PRD `hosted-accounts`, phase 1, task 1, ADR-0017). Same
 * shape as `DuplicateServerError` (`src/registry/store.ts`): the message is
 * pinned by text, because it is what an operator or a `describeError` caller
 * sees verbatim.
 */

describe('StdioServerRefusedError', () => {
  test('names the server and points at the fix, verbatim', () => {
    const error = new StdioServerRefusedError('legacy-fs')

    expect(error.message).toBe(
      'server "legacy-fs" is stdio: this install refuses stdio servers (tenant mode) — register it over https',
    )
    expect(error.name).toBe('StdioServerRefusedError')
    expect(error).toBeInstanceOf(Error)
  })
})
