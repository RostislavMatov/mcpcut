import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { loadPolicy } from '../../src/policy/load.js'
import { grantsHashOf, policyHashOf } from '../../src/policy/provenance.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { typecheckSource } from '../support/typecheck.js'

/**
 * Decision-record provenance (M5 wave 1): the fingerprints an auditor uses
 * to answer "which rules was this call decided under". `policyHashOf`
 * fingerprints the *effective* policy, so the two properties that matter are
 * (a) reproducibility across processes and (b) sensitivity to any real
 * change in the rules.
 */

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-provenance-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function policyOf(overrides: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({ version: 1, ...overrides })
  if (!result.ok) throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

/** Loads `contents` through the real loader, exactly as a process start would. */
async function loadPolicyFrom(contents: string): Promise<Policy> {
  const path = join(tempDir, 'policy.json')
  await writeFile(path, contents, 'utf8')
  const result = await loadPolicy({ explicitPath: path })
  if (result.status !== 'loaded') throw new Error(`policy did not load: ${result.status}`)
  return result.policy
}

describe('policyHashOf', () => {
  test('returns a lowercase 64-character hex digest', () => {
    expect(policyHashOf(policyOf())).toMatch(SHA256_HEX_PATTERN)
  })

  test('two independent loads of the same policy file yield the same hash', async () => {
    // The audit property: a fingerprint recorded by yesterday's process must
    // be reproducible by today's, with nothing carried over between them.
    const contents = JSON.stringify({
      version: 1,
      defaultDecision: 'deny',
      servers: { github: { tools: { 'delete_*': 'require-approval' } } },
    })

    const first = policyHashOf(await loadPolicyFrom(contents))
    const second = policyHashOf(await loadPolicyFrom(contents))

    expect(second).toBe(first)
  })

  test('key insertion order in the source file does not change the hash', async () => {
    const ordered = JSON.stringify({
      version: 1,
      defaultDecision: 'deny',
      servers: { github: { tools: { 'delete_*': 'deny', 'read_*': 'allow' } } },
    })
    const shuffled = JSON.stringify({
      servers: { github: { tools: { 'read_*': 'allow', 'delete_*': 'deny' } } },
      defaultDecision: 'deny',
      version: 1,
    })

    const orderedHash = policyHashOf(await loadPolicyFrom(ordered))
    const shuffledHash = policyHashOf(await loadPolicyFrom(shuffled))

    expect(shuffledHash).toBe(orderedHash)
  })

  test('two different files that resolve to the same effective policy hash the same', async () => {
    // Spelling a schema default out explicitly is not a rule change, and the
    // fingerprint of "the rules that ran" must say so.
    const implicitDefaults = JSON.stringify({ version: 1, defaultDecision: 'deny' })
    const explicitDefaults = JSON.stringify({
      version: 1,
      defaultDecision: 'deny',
      quarantine: { enabled: true },
    })

    const implicitHash = policyHashOf(await loadPolicyFrom(implicitDefaults))
    const explicitHash = policyHashOf(await loadPolicyFrom(explicitDefaults))

    expect(explicitHash).toBe(implicitHash)
  })

  test('a single changed setting changes the hash', () => {
    const allowing = policyHashOf(policyOf({ defaultDecision: 'allow' }))
    const denying = policyHashOf(policyOf({ defaultDecision: 'deny' }))

    expect(denying).not.toBe(allowing)
  })

  test('a changed per-server rule changes the hash', () => {
    const base = policyHashOf(
      policyOf({ servers: { github: { tools: { 'delete_*': 'deny' } } } }),
    )
    const loosened = policyHashOf(
      policyOf({ servers: { github: { tools: { 'delete_*': 'require-approval' } } } }),
    )

    expect(loosened).not.toBe(base)
  })

  test('quarantine being switched off changes the hash', () => {
    const on = policyHashOf(policyOf({ quarantine: { enabled: true } }))
    const off = policyHashOf(policyOf({ quarantine: { enabled: false } }))

    expect(off).not.toBe(on)
  })
})

describe('grantsHashOf', () => {
  test('returns a lowercase 64-character hex digest', () => {
    expect(grantsHashOf({ github: { tools: ['read_*'] } })).toMatch(SHA256_HEX_PATTERN)
  })

  test('key order within the grant matrix does not change the hash', () => {
    const ordered = grantsHashOf({ github: { tools: ['read_*'] }, slack: { tools: ['post'] } })
    const shuffled = grantsHashOf({ slack: { tools: ['post'] }, github: { tools: ['read_*'] } })

    expect(shuffled).toBe(ordered)
  })

  test('adding a grant changes the hash', () => {
    const before = grantsHashOf({ github: { tools: ['read_*'] } })
    const after = grantsHashOf({ github: { tools: ['read_*', 'write_file'] } })

    expect(after).not.toBe(before)
  })

  test('removing a server from the matrix changes the hash', () => {
    const both = grantsHashOf({ github: { tools: ['read_*'] }, slack: { tools: ['post'] } })
    const one = grantsHashOf({ github: { tools: ['read_*'] } })

    expect(one).not.toBe(both)
  })

  test('an empty matrix hashes stably', () => {
    expect(grantsHashOf({})).toBe(grantsHashOf({}))
  })
})

/**
 * GOLDEN VECTORS — read this before changing anything below.
 *
 * `policyHashOf` fingerprints the EFFECTIVE policy: the parsed object with
 * the schema's defaults applied. That is the right thing to fingerprint (an
 * auditor must be able to reproduce the rules that actually ran, and a raw
 * file says nothing about what the unspecified settings resolved to) but it
 * has a consequence: the digest depends on the control-plane BUILD, not only
 * on the operator's file. Add one defaulted field to `policy/schema.ts` and
 * every unchanged policy file's fingerprint changes — with nothing in the
 * journal to distinguish "the operator loosened the policy" from "we shipped
 * a release".
 *
 * These tests are the guard. They pin two things at once:
 *
 *  1. The exact canonical byte string each hash is taken over, written out by
 *     hand here rather than produced by `canonicalJson`, so the serialization
 *     itself is pinned and not merely reproduced.
 *  2. The literal digest, so the value appears in a diff.
 *
 * IF YOU ARE HERE BECAUSE ONE OF THESE FAILED: you have changed the meaning
 * of every fingerprint ever recorded. Records written before your change name
 * a ruleset that can no longer be reproduced from today's build, so an
 * auditor comparing an old record against a re-hash of the same rules will
 * see a mismatch that is not evidence of tampering. Do not simply update the
 * constants. Establish which milestone owns the change, document the break
 * (ADR / report format version — wave 4's ADR-0007 owns the versioning), and
 * only then move these values, in the same commit as that documentation.
 */
describe('golden vectors: the fingerprints of a fixed input never drift silently', () => {
  /**
   * The canonical serialization of `parsePolicy({ version: 1 })` — every
   * schema default spelled out, object keys sorted at every level. Written by
   * hand: if `canonicalJson` produced it, this test could not catch a change
   * in `canonicalJson`.
   */
  const MINIMAL_POLICY_CANONICAL_JSON =
    '{"approval":{"grantTtlMs":300000,"onTimeout":"deny","timeoutMs":60000},' +
    '"defaultDecision":"require-approval","journal":{"failClosed":false},' +
    '"quarantine":{"enabled":true,"onQuarantined":"require-approval"},' +
    '"toolsList":{"filter":"hide-denied"},"version":1}'

  /** SHA-256 of the string above. Changing either means changing history. */
  const MINIMAL_POLICY_HASH = '27cae103c5ec874ec0d6aa33bc6d16440ca415d9a24849630a0ed1a747cd4da3'

  /** A fixed matrix with every grant field populated and every list out of order. */
  const FIXED_GRANT_MATRIX = {
    github: {
      prompts: ['review', 'summarize'],
      resources: ['file://b', 'file://a'],
      tools: ['write_file', 'read_*'],
    },
    slack: { tools: '*' },
  } as const

  /** Its canonical form: keys sorted, pattern lists sorted, `'*'` untouched. */
  const FIXED_GRANT_MATRIX_CANONICAL_JSON =
    '{"github":{"prompts":["review","summarize"],"resources":["file://a","file://b"],' +
    '"tools":["read_*","write_file"]},"slack":{"tools":"*"}}'

  const FIXED_GRANT_MATRIX_HASH =
    'db1fa43aab4765ad92d778ab126f2094dd98f4a0d88c177f662b41be90b56849'

  /** SHA-256 taken straight from `node:crypto`, independent of `policy/hash.ts`. */
  function sha256Of(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex')
  }

  test('the effective minimal policy hashes to its recorded digest', () => {
    expect(policyHashOf(policyOf())).toBe(MINIMAL_POLICY_HASH)
  })

  test('and that digest is the SHA-256 of the exact canonical bytes named here', () => {
    // Fails if the canonicalization changes even when the digest constant is
    // dutifully updated, so the two cannot drift apart unnoticed.
    expect(sha256Of(MINIMAL_POLICY_CANONICAL_JSON)).toBe(MINIMAL_POLICY_HASH)
    expect(policyHashOf(policyOf())).toBe(sha256Of(MINIMAL_POLICY_CANONICAL_JSON))
  })

  test('the fixed grant matrix hashes to its recorded digest', () => {
    expect(grantsHashOf(FIXED_GRANT_MATRIX)).toBe(FIXED_GRANT_MATRIX_HASH)
  })

  test('and that digest is the SHA-256 of the exact canonical bytes named here', () => {
    expect(sha256Of(FIXED_GRANT_MATRIX_CANONICAL_JSON)).toBe(FIXED_GRANT_MATRIX_HASH)
    expect(grantsHashOf(FIXED_GRANT_MATRIX)).toBe(sha256Of(FIXED_GRANT_MATRIX_CANONICAL_JSON))
  })
})

describe('grantsHashOf does not move on differences that grant nothing', () => {
  /**
   * `agent grant a1 github --tool read_* --tool write_file` and the same two
   * flags in the other order authorize *identically* — `grantServer` stores
   * the CLI array verbatim, and `scope.ts` builds a lookup from it, so
   * position carries no meaning. A fingerprint that moved on the reorder
   * would show an auditor an authorization change where none happened, which
   * is exactly the "cry wolf" failure `policyHashOf`'s own rationale rejects.
   * The two functions in this file now apply the same principle.
   */
  test('reordered tool patterns hash identically', () => {
    const forward = grantsHashOf({ github: { tools: ['read_*', 'write_file'] } })
    const reversed = grantsHashOf({ github: { tools: ['write_file', 'read_*'] } })

    expect(reversed).toBe(forward)
  })

  test('reordered resource and prompt patterns hash identically', () => {
    const forward = grantsHashOf({
      github: { tools: ['a'], resources: ['file://x', 'file://y'], prompts: ['p1', 'p2'] },
    })
    const reversed = grantsHashOf({
      github: { tools: ['a'], resources: ['file://y', 'file://x'], prompts: ['p2', 'p1'] },
    })

    expect(reversed).toBe(forward)
  })

  test('normalization reaches every server in the matrix, not just the first', () => {
    const forward = grantsHashOf({
      github: { tools: ['a', 'b'] },
      slack: { tools: ['post', 'read'] },
    })
    const reversed = grantsHashOf({
      github: { tools: ['b', 'a'] },
      slack: { tools: ['read', 'post'] },
    })

    expect(reversed).toBe(forward)
  })

  test('a genuine addition still moves the hash', () => {
    // The other half: order-insensitivity must not become set-insensitivity.
    const before = grantsHashOf({ github: { tools: ['read_*'] } })
    const after = grantsHashOf({ github: { tools: ['write_file', 'read_*'] } })

    expect(after).not.toBe(before)
  })

  test('a genuine removal still moves the hash', () => {
    const both = grantsHashOf({ github: { tools: ['write_file', 'read_*'] } })
    const one = grantsHashOf({ github: { tools: ['read_*'] } })

    expect(one).not.toBe(both)
  })

  test('a repeated pattern is not silently collapsed into a single one', () => {
    // Sorting is the normalization, not deduplication: two matrices that
    // differ in content must keep differing, however harmless the difference.
    const once = grantsHashOf({ github: { tools: ['read_*'] } })
    const twice = grantsHashOf({ github: { tools: ['read_*', 'read_*'] } })

    expect(twice).not.toBe(once)
  })

  test('a wildcard grant is left exactly as it is', () => {
    // `'*'` is a literal, not a one-element list, and must not be confusable
    // with `['*']` -- "every tool" and "the tool named `*`" are different
    // claims about what an agent could do.
    expect(grantsHashOf({ github: { tools: '*' } })).toBe(grantsHashOf({ github: { tools: '*' } }))
    expect(grantsHashOf({ github: { tools: '*' } })).not.toBe(
      grantsHashOf({ github: { tools: ['*'] } }),
    )
  })

  test('a whole AgentRecord cannot be passed in place of the matrix', () => {
    // `grantsHashOf(grants: unknown)` let a future caller hand over the whole
    // record, folding `tokenHash` into the fingerprint -- which would then
    // move on token ROTATION, turning a published digest into a rotation
    // oracle and ending its meaning as "these are the rules" (SEC-L1). The
    // stated reason for `unknown` (keeping the policy layer independent of
    // the agents module) is fully served by a structural type.
    const diagnostics = typecheckSource(`
      import type { AgentRecord } from '../../src/agents/schema.js'
      import { grantsHashOf } from '../../src/policy/provenance.js'

      export function fingerprint(record: AgentRecord): string {
        return grantsHashOf(record)
      }
    `)

    expect(diagnostics).toMatch(/error TS/)
  })

  test('the matrix itself still passes', () => {
    const diagnostics = typecheckSource(`
      import type { AgentRecord } from '../../src/agents/schema.js'
      import { grantsHashOf } from '../../src/policy/provenance.js'

      export function fingerprint(record: AgentRecord): string {
        return grantsHashOf(record.grants)
      }
    `)

    expect(diagnostics).toBe('')
  })

  test('a matrix with a non-object server entry hashes without throwing', () => {
    // The input is `Readonly<Record<string, unknown>>`: a hand-edited or
    // foreign store is not this function's to validate, but it must not
    // explode on the way to a fingerprint.
    expect(grantsHashOf({ github: null })).toMatch(SHA256_HEX_PATTERN)
    expect(grantsHashOf({ github: 'nonsense' })).toMatch(SHA256_HEX_PATTERN)
  })
})
