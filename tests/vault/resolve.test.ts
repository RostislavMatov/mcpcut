import { describe, expect, test } from 'vitest'
import { isVaultRef, resolveVaultRefs } from '../../src/vault/resolve.js'
import type { ReadSecretValuesResult } from '../../src/vault/store.js'

/** Fake reader over an in-memory map; returns only the names that exist, like the real store. */
function readerOf(values: Record<string, string>) {
  return async (names: readonly string[]): Promise<ReadSecretValuesResult> => {
    const found: Record<string, string> = {}
    for (const name of names) {
      const value = values[name]
      if (value !== undefined) found[name] = value
    }
    return { status: 'read', values: found }
  }
}

describe('isVaultRef', () => {
  test.each([
    ['vault:github-pat', true],
    ['vault:a', true],
    ['vault:0-key', true],
    ['vault:', false],
    ['vault:UPPER', false],
    ['vault:-leading', false],
    ['vault:has_underscore', false],
    [`vault:${'a'.repeat(65)}`, false],
    ['Vault:github-pat', false],
    ['ghp_literaltoken', false],
    ['', false],
  ])('%j → %s', (value, expected) => {
    expect(isVaultRef(value)).toBe(expected)
  })
})

describe('resolveVaultRefs', () => {
  test('replaces vault refs and passes literals through untouched', async () => {
    const result = await resolveVaultRefs(
      { GITHUB_TOKEN: 'vault:github-pat', LOG_LEVEL: 'debug' },
      readerOf({ 'github-pat': 'tok-123' }),
    )

    expect(result).toEqual({
      status: 'resolved',
      values: { GITHUB_TOKEN: 'tok-123', LOG_LEVEL: 'debug' },
    })
  })

  test('empty record resolves to an empty record', async () => {
    const result = await resolveVaultRefs({}, readerOf({}))

    expect(result).toEqual({ status: 'resolved', values: {} })
  })

  test('two keys referencing the same secret both resolve', async () => {
    const result = await resolveVaultRefs(
      { A: 'vault:shared', B: 'vault:shared' },
      readerOf({ shared: 's' }),
    )

    expect(result).toEqual({ status: 'resolved', values: { A: 's', B: 's' } })
  })

  test('missing secrets are reported all at once, not one by one', async () => {
    const result = await resolveVaultRefs(
      { A: 'vault:first-missing', B: 'vault:present', C: 'vault:second-missing' },
      readerOf({ present: 'p' }),
    )

    expect(result).toEqual({
      status: 'missing-secrets',
      missing: ['first-missing', 'second-missing'],
    })
  })

  test('a value that starts with "vault:" but is not a valid ref is an error, never a literal', async () => {
    const result = await resolveVaultRefs(
      { A: 'vault:Not Valid', B: 'vault:' },
      readerOf({}),
    )

    expect(result.status).toBe('invalid-refs')
    if (result.status !== 'invalid-refs') return
    expect(result.refs).toEqual(['vault:Not Valid', 'vault:'])
  })

  test('vault store failures propagate as vault-error', async () => {
    const result = await resolveVaultRefs({ A: 'vault:x' }, async () => ({
      status: 'not-initialized',
    }))

    expect(result).toEqual({ status: 'vault-error', failure: { status: 'not-initialized' } })
  })

  test('a record with no refs never touches the vault', async () => {
    let calls = 0
    const result = await resolveVaultRefs({ A: 'literal' }, async () => {
      calls += 1
      return { status: 'read', values: {} }
    })

    expect(result).toEqual({ status: 'resolved', values: { A: 'literal' } })
    expect(calls).toBe(0)
  })
})
