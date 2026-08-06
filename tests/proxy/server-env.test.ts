import { describe, expect, test } from 'vitest'
import { SYSTEM_ENV_ALLOWLIST } from '../../src/config.js'
import {
  buildServerEnv,
  type BuildServerEnvResult,
  type ResolveEnvRefsFn,
} from '../../src/proxy/server-env.js'
import { resolveVaultRefs } from '../../src/vault/resolve.js'

/** A resolver that treats every value as a literal (no vault refs involved). */
const literalResolver: ResolveEnvRefsFn = (record) =>
  Promise.resolve({ status: 'resolved', values: { ...record } })

function expectBuilt(result: BuildServerEnvResult): Readonly<Record<string, string>> {
  expect(result.status).toBe('built')
  if (result.status !== 'built') throw new Error('unreachable')
  return result.env
}

describe('buildServerEnv', () => {
  describe('allowlist intersection', () => {
    interface IntersectionCase {
      name: string
      processEnv: NodeJS.ProcessEnv
      allowlist: readonly string[]
      expected: Record<string, string>
    }

    const cases: IntersectionCase[] = [
      {
        name: 'keeps only allowlisted variables present in processEnv',
        processEnv: { PATH: '/usr/bin', SECRET_PLANE_KEY: 'plane-secret', HOME: '/home/u' },
        allowlist: ['PATH', 'HOME'],
        expected: { PATH: '/usr/bin', HOME: '/home/u' },
      },
      {
        name: 'allowlisted names absent from processEnv are simply not set',
        processEnv: { PATH: '/usr/bin' },
        allowlist: ['PATH', 'HOME', 'TMPDIR'],
        expected: { PATH: '/usr/bin' },
      },
      {
        name: 'empty allowlist yields an env with no inherited variables',
        processEnv: { PATH: '/usr/bin', HOME: '/home/u' },
        allowlist: [],
        expected: {},
      },
      {
        name: 'undefined values in processEnv are filtered out (Node env typing allows them)',
        processEnv: { PATH: '/usr/bin', HOME: undefined },
        allowlist: ['PATH', 'HOME'],
        expected: { PATH: '/usr/bin' },
      },
    ]

    test.each(cases)('$name', async ({ processEnv, allowlist, expected }) => {
      const result = await buildServerEnv({
        processEnv,
        allowlist,
        declaredEnv: {},
        resolveRefs: literalResolver,
      })

      expect(expectBuilt(result)).toEqual(expected)
    })
  })

  describe('declared env layering', () => {
    test('declared literal overrides an inherited allowlisted variable', async () => {
      const result = await buildServerEnv({
        processEnv: { PATH: '/plane/bin', HOME: '/home/plane' },
        allowlist: ['PATH', 'HOME'],
        declaredEnv: { PATH: '/server/bin', EXTRA: 'value' },
        resolveRefs: literalResolver,
      })

      expect(expectBuilt(result)).toEqual({
        PATH: '/server/bin',
        HOME: '/home/plane',
        EXTRA: 'value',
      })
    })

    test('declared vault reference is dereferenced through the injected resolver', async () => {
      const result = await buildServerEnv({
        processEnv: {},
        allowlist: [],
        declaredEnv: { GITHUB_PAT: 'vault:github-pat', MODE: 'ro' },
        resolveRefs: (record) =>
          resolveVaultRefs(record, () =>
            Promise.resolve({ status: 'read', values: { 'github-pat': 'decrypted-marker' } }),
          ),
      })

      expect(expectBuilt(result)).toEqual({ GITHUB_PAT: 'decrypted-marker', MODE: 'ro' })
    })
  })

  describe('resolver failures pass through unchanged', () => {
    test('missing vault secrets surface every missing name at once', async () => {
      const result = await buildServerEnv({
        processEnv: { PATH: '/usr/bin' },
        allowlist: ['PATH'],
        declaredEnv: { A: 'vault:absent-a', B: 'vault:absent-b' },
        resolveRefs: (record) =>
          resolveVaultRefs(record, () => Promise.resolve({ status: 'read', values: {} })),
      })

      expect(result).toEqual({ status: 'missing-secrets', missing: ['absent-a', 'absent-b'] })
    })

    test('invalid vault refs are reported, never passed to the child as literals', async () => {
      const result = await buildServerEnv({
        processEnv: {},
        allowlist: [],
        declaredEnv: { BAD: 'vault:NOT_VALID_NAME' },
        resolveRefs: (record) =>
          resolveVaultRefs(record, () => Promise.resolve({ status: 'read', values: {} })),
      })

      expect(result).toEqual({ status: 'invalid-refs', refs: ['vault:NOT_VALID_NAME'] })
    })

    test('vault store failure is forwarded as-is', async () => {
      const result = await buildServerEnv({
        processEnv: {},
        allowlist: [],
        declaredEnv: { KEY: 'vault:some-name' },
        resolveRefs: (record) =>
          resolveVaultRefs(record, () => Promise.resolve({ status: 'not-initialized' })),
      })

      expect(result).toEqual({ status: 'vault-error', failure: { status: 'not-initialized' } })
    })
  })

  describe('immutability', () => {
    test('does not mutate processEnv or declaredEnv', async () => {
      const processEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/u' }
      const declaredEnv = { PATH: '/server/bin' }
      const processEnvSnapshot = { ...processEnv }
      const declaredEnvSnapshot = { ...declaredEnv }

      await buildServerEnv({
        processEnv,
        allowlist: ['PATH', 'HOME'],
        declaredEnv,
        resolveRefs: literalResolver,
      })

      expect(processEnv).toEqual(processEnvSnapshot)
      expect(declaredEnv).toEqual(declaredEnvSnapshot)
    })

    test('returns a frozen env object', async () => {
      const result = await buildServerEnv({
        processEnv: { PATH: '/usr/bin' },
        allowlist: ['PATH'],
        declaredEnv: {},
        resolveRefs: literalResolver,
      })

      expect(Object.isFrozen(expectBuilt(result))).toBe(true)
    })
  })
})

describe('SYSTEM_ENV_ALLOWLIST', () => {
  test('never includes NODE_OPTIONS (code-injection vector into the child)', () => {
    expect(SYSTEM_ENV_ALLOWLIST).not.toContain('NODE_OPTIONS')
  })

  test('includes PATH so registry servers can locate their binaries', () => {
    expect(SYSTEM_ENV_ALLOWLIST).toContain('PATH')
  })

  test('contains no duplicate names', () => {
    expect(new Set(SYSTEM_ENV_ALLOWLIST).size).toBe(SYSTEM_ENV_ALLOWLIST.length)
  })
})
