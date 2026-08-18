import { describe, expect, test } from 'vitest'
import { buildDecisionRecord } from '../../src/journal/decision.js'
import { REDACTED_PLACEHOLDER } from '../../src/config.js'
import type { DecisionInfo } from '../../src/journal/record.js'

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

function stubClock(timestampMs: number): () => number {
  return () => timestampMs
}

function decisionInfo(overrides: Partial<DecisionInfo> = {}): DecisionInfo {
  return {
    outcome: 'deny',
    rule: 'servers.github.tools.delete_*',
    serverName: 'github',
    toolName: 'delete_repo',
    toolClass: 'destructive',
    quarantineState: 'known',
    argsHash: 'sha256:abc123',
    ...overrides,
  }
}

describe('buildDecisionRecord', () => {
  describe('base record shape', () => {
    test('builds a record with kind "decision" and direction "client→server"', () => {
      const record = buildDecisionRecord({
        sessionId: 'session-1',
        decision: decisionInfo(),
        clock: stubClock(1_700_000_000_000),
      })

      expect(record.kind).toBe('decision')
      expect(record.direction).toBe('client→server')
      expect(record.sessionId).toBe('session-1')
    })

    test('assigns a ULID id and an ISO-8601 ts from the injected clock', () => {
      const record = buildDecisionRecord({
        sessionId: 'session-1',
        decision: decisionInfo(),
        clock: stubClock(1_700_000_000_000),
      })

      expect(record.id).toMatch(ULID_PATTERN)
      expect(record.ts).toBe(new Date(1_700_000_000_000).toISOString())
    })

    test('defaults to Date.now when no clock is injected', () => {
      const record = buildDecisionRecord({ sessionId: 'session-1', decision: decisionInfo() })

      expect(Number.isNaN(Date.parse(record.ts))).toBe(false)
    })

    test('carries the decision fields through on record.decision', () => {
      const record = buildDecisionRecord({
        sessionId: 'session-1',
        decision: decisionInfo({
          outcome: 'require-approval-pending',
          rule: 'servers.github.tools.create_issue',
          serverName: 'github',
          toolName: 'create_issue',
          toolClass: 'write',
          quarantineState: 'new',
          argsHash: 'sha256:def456',
        }),
        clock: stubClock(1_000),
      })

      expect(record.decision).toEqual({
        outcome: 'require-approval-pending',
        rule: 'servers.github.tools.create_issue',
        serverName: 'github',
        toolName: 'create_issue',
        toolClass: 'write',
        quarantineState: 'new',
        argsHash: 'sha256:def456',
      })
    })

    test('carries optional approvalId and latencyMs when provided', () => {
      const record = buildDecisionRecord({
        sessionId: 'session-1',
        decision: decisionInfo({
          outcome: 'approved',
          approvalId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          latencyMs: 4200,
        }),
        clock: stubClock(1_000),
      })

      expect(record.decision?.approvalId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
      expect(record.decision?.latencyMs).toBe(4200)
    })

    test('omits approvalId and latencyMs when not provided', () => {
      const record = buildDecisionRecord({
        sessionId: 'session-1',
        decision: decisionInfo(),
        clock: stubClock(1_000),
      })

      expect(record.decision).not.toHaveProperty('approvalId')
      expect(record.decision).not.toHaveProperty('latencyMs')
    })
  })

  describe('immutability', () => {
    test('the returned record is frozen', () => {
      const record = buildDecisionRecord({
        sessionId: 'session-1',
        decision: decisionInfo(),
        clock: stubClock(1_000),
      })

      expect(Object.isFrozen(record)).toBe(true)
    })

    test('the nested decision object is also frozen', () => {
      const record = buildDecisionRecord({
        sessionId: 'session-1',
        decision: decisionInfo(),
        clock: stubClock(1_000),
      })

      expect(Object.isFrozen(record.decision)).toBe(true)
    })

    test('mutating the input decision object after the call does not affect the built record', () => {
      const mutableDecision = decisionInfo({ outcome: 'allow' })
      const record = buildDecisionRecord({
        sessionId: 'session-1',
        decision: mutableDecision,
        clock: stubClock(1_000),
      })

      ;(mutableDecision as { outcome: string }).outcome = 'deny'

      expect(record.decision?.outcome).toBe('allow')
    })
  })

  describe('toolName redaction', () => {
    test('redacts a secret embedded in toolName before it reaches the record', () => {
      const record = buildDecisionRecord({
        sessionId: 'session-1',
        decision: decisionInfo({ toolName: 'call_tool Bearer sk-live-abc123' }),
        clock: stubClock(1_000),
      })

      expect(record.decision?.toolName).not.toContain('sk-live-abc123')
      expect(record.decision?.toolName).toContain(REDACTED_PLACEHOLDER)
    })

    test('leaves a plain toolName unchanged', () => {
      const record = buildDecisionRecord({
        sessionId: 'session-1',
        decision: decisionInfo({ toolName: 'list_files' }),
        clock: stubClock(1_000),
      })

      expect(record.decision?.toolName).toBe('list_files')
    })
  })

  describe('actor redaction', () => {
    /**
     * `actor` is the other externally-sourced string on a decision record
     * (M5 wave-2 review, finding 4). On the late-approval path it comes from a
     * STORED resolved record — hand-editable text, as `grants.ts` says of its
     * own inputs — and was validated for type and length but never for
     * content, making it the one decision field reaching the journal without
     * passing `redactString`. Redaction is the only path into the journal, and
     * wave 4 folds this field into a signed chain, so it is redacted at the
     * same choke point `toolName` already uses: every producer is covered, not
     * just the call site that surfaced it.
     */
    test('redacts a secret embedded in a stored actor before it reaches the record', () => {
      const record = buildDecisionRecord({
        sessionId: 'session-1',
        decision: decisionInfo({ actor: 'cli:Bearer sk-live-abc123' }),
        clock: stubClock(1_000),
      })

      expect(record.decision?.actor).not.toContain('sk-live-abc123')
      expect(record.decision?.actor).toContain(REDACTED_PLACEHOLDER)
    })

    test.each(['cli:alice', 'ui:alice', 'cli:release-captain', 'ui:ops-team-1'])(
      'leaves the legitimate actor %s byte-identical',
      (actor) => {
        // `ADMIN_NAME_PATTERN` is `^[a-z0-9][a-z0-9-]{0,63}$`, so a real
        // `cli:`/`ui:` actor has nothing a value pattern can match. Redaction
        // must not be bought at the price of mangling real attribution.
        const record = buildDecisionRecord({
          sessionId: 'session-1',
          decision: decisionInfo({ actor }),
          clock: stubClock(1_000),
        })

        expect(record.decision?.actor).toBe(actor)
      },
    )

    test('a record with no actor gains no actor key', () => {
      // Absence must stay absence: `grantsHash` absence already MEANS
      // something on these records, and an invented `actor: undefined` would
      // be a new key on every pre-attribution decision.
      const record = buildDecisionRecord({
        sessionId: 'session-1',
        decision: decisionInfo(),
        clock: stubClock(1_000),
      })

      expect(Object.hasOwn(record.decision as object, 'actor')).toBe(false)
    })
  })

  describe('args redaction into payload', () => {
    test('redacts a secret found in tool-call args before it reaches payload', () => {
      const record = buildDecisionRecord({
        sessionId: 'session-1',
        decision: decisionInfo(),
        args: { token: 'super-secret-value' },
        clock: stubClock(1_000),
      })
      const serialized = JSON.stringify(record.payload)

      expect(serialized).not.toContain('super-secret-value')
      expect(serialized).toContain(REDACTED_PLACEHOLDER)
    })

    test('a marker secret embedded deep in nested args does not survive serialization', () => {
      const record = buildDecisionRecord({
        sessionId: 'session-1',
        decision: decisionInfo(),
        args: { nested: { deeper: { apiKey: 'sk-live-MARKER-SECRET-999' } } },
        clock: stubClock(1_000),
      })
      const serialized = JSON.stringify(record)

      expect(serialized).not.toContain('sk-live-MARKER-SECRET-999')
    })

    test('sets payload to null when args are omitted', () => {
      const record = buildDecisionRecord({
        sessionId: 'session-1',
        decision: decisionInfo(),
        clock: stubClock(1_000),
      })

      expect(record.payload).toBeNull()
    })

    test('preserves non-sensitive args structurally', () => {
      const record = buildDecisionRecord({
        sessionId: 'session-1',
        decision: decisionInfo(),
        args: { path: '/tmp/file.txt', recursive: true },
        clock: stubClock(1_000),
      })

      expect(record.payload).toEqual({ path: '/tmp/file.txt', recursive: true })
    })
  })

  describe('never throws', () => {
    test('does not throw when args contain a circular reference', () => {
      const circular: Record<string, unknown> = { a: 1 }
      circular['self'] = circular

      expect(() =>
        buildDecisionRecord({
          sessionId: 'session-1',
          decision: decisionInfo(),
          args: circular,
          clock: stubClock(1_000),
        }),
      ).not.toThrow()
    })
  })
})
