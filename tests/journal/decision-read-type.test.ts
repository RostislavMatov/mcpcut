import { describe, expect, test } from 'vitest'
import { parseJournalLine } from '../../src/journal/line-source.js'
import { typecheckSource as typecheck } from '../support/typecheck.js'

/**
 * The write/read asymmetry of decision provenance (M5 wave-1 review, HIGH 2).
 *
 * `DecisionInfo.policyHash` is REQUIRED, and the single writer choke point
 * makes that true by construction for everything written from wave 1 on. But
 * every record already on disk predates the field, and `isDecisionShape`
 * (`line-source.ts`) does not validate it — so a legacy line would present as
 * a `JournalRecord` whose `decision.policyHash` is typed `string` and is
 * `undefined` at runtime. Wave 3's chain builder folding the literal
 * `"undefined"` into a link, or wave 5's report throwing on `.slice()`, would
 * both be invisible to the compiler.
 *
 * The fix splits the two sides: `PersistedDecisionInfo` (read) has an
 * OPTIONAL `policyHash`, `DecisionInfo` (write) keeps it required. Since the
 * whole point is a compile-time obligation, these are compile-time tests --
 * see `tests/support/typecheck.ts` for why they must be.
 */

describe('a record read back from storage does not promise provenance', () => {
  test('treating a persisted policyHash as a plain string does not compile', () => {
    // The failure wave 3 must not be able to write by accident.
    const diagnostics = typecheck(`
      import type { JournalRecord } from '../../src/journal/record.js'

      export function chainLinkOf(record: JournalRecord): string {
        const decision = record.decision
        if (decision === undefined) return ''
        const hash: string = decision.policyHash
        return hash.slice(0, 8)
      }
    `)

    // tsc names the assignment, not the property, so the specific pin is the
    // reason: absence is part of the read-side type.
    expect(diagnostics).toMatch(/error TS2322/)
    expect(diagnostics).toMatch(/'string \| undefined' is not assignable to type 'string'/)
  })

  test('handling the absence explicitly compiles cleanly', () => {
    // The other half of the contract: absence must be *handleable*, not the
    // field removed. A guard that only rejected would be satisfied by
    // deleting `policyHash` from the read type, which helps nobody.
    const diagnostics = typecheck(`
      import type { JournalRecord } from '../../src/journal/record.js'

      export function chainLinkOf(record: JournalRecord): string {
        const hash: string | undefined = record.decision?.policyHash
        return hash === undefined ? '<unprovenanced>' : hash.slice(0, 8)
      }
    `)

    expect(diagnostics).toBe('')
  })

  test('the WRITE side still requires policyHash', () => {
    // The property both reviewers endorsed: no decision record can be
    // assembled for writing without provenance.
    const diagnostics = typecheck(`
      import type { DecisionInfo } from '../../src/journal/record.js'

      export const decision: DecisionInfo = {
        outcome: 'allow',
        rule: 'default',
        serverName: 'srv',
        toolName: 'read_file',
        toolClass: 'read',
        quarantineState: 'known',
        argsHash: '',
      }
    `)

    expect(diagnostics).toMatch(/policyHash/)
  })

  test('a fully provenanced write-side literal compiles', () => {
    const diagnostics = typecheck(`
      import type { DecisionInfo } from '../../src/journal/record.js'

      export const decision: DecisionInfo = {
        outcome: 'allow',
        rule: 'default',
        serverName: 'srv',
        toolName: 'read_file',
        toolClass: 'read',
        quarantineState: 'known',
        argsHash: '',
        policyHash: 'a'.repeat(64),
      }
    `)

    expect(diagnostics).toBe('')
  })
})

describe('a legacy decision line stays readable and stays unprovenanced', () => {
  const LEGACY_LINE = JSON.stringify({
    id: '01J0000000000000000000000A',
    ts: '2026-08-01T00:00:00.000Z',
    sessionId: 'legacy-session',
    direction: 'client→server',
    kind: 'decision',
    payload: null,
    decision: {
      outcome: 'allow',
      rule: 'default',
      serverName: 'github',
      toolName: 'read_file',
      toolClass: 'read',
      quarantineState: 'known',
      argsHash: 'a'.repeat(64),
    },
  })

  test('it parses rather than being rejected', () => {
    // Pre-M5 archives must stay readable: an auditor's first request is the
    // old data, and rejecting it would destroy more evidence than it saves.
    expect(parseJournalLine(LEGACY_LINE)?.kind).toBe('decision')
  })

  test('the missing fingerprint is ABSENT, never fabricated', () => {
    // Not `''`, not the string "undefined": a reader must be able to tell
    // "recorded under no known ruleset" from any real digest.
    const decision = parseJournalLine(LEGACY_LINE)?.decision
    expect(decision).toBeDefined()
    expect(Object.hasOwn(decision as object, 'policyHash')).toBe(false)
    expect(decision?.policyHash).toBeUndefined()
  })
})
