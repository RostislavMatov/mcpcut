import { describe, expect, test } from 'vitest'
import { buildPoolRecord } from '../../src/journal/pool-record.js'
import { JOURNAL_KINDS } from '../../src/journal/reader.js'

/**
 * The `kind: 'pool'` record (ADR-0015 §8): what one moment of a pool session
 * says about itself. It is the ONE binding between a pool session and the
 * per-server child sessions underneath it — `open`/`close` bound its life,
 * `attach` names each child by journal session id.
 *
 * Unlike a probe or a policy edit, a pool event is not sessionless: the pool
 * HAS a session, and that session is the subject of the record. Its id is
 * therefore minted per pool session, never a reserved literal — otherwise
 * every pool of every agent would share one ledger.
 */

const AT = () => Date.parse('2026-09-22T10:00:00.000Z')

function build(info: Parameters<typeof buildPoolRecord>[0]['pool'], knownSecrets?: string[]) {
  return buildPoolRecord({
    sessionId: '01JPOOLSESSION0000000000AA',
    pool: info,
    clock: AT,
    ...(knownSecrets !== undefined ? { knownSecrets } : {}),
  })
}

describe('buildPoolRecord', () => {
  test('stamps an open with the pool session id and the servers in it', () => {
    // Arrange / Act
    const record = build({ agentName: 'bot', event: 'open', members: ['fs', 'github'] })

    // Assert
    expect(record).toMatchObject({
      sessionId: '01JPOOLSESSION0000000000AA',
      kind: 'pool',
      // The plane spoke as the client here, exactly as a probe does.
      direction: 'client→server',
      ts: '2026-09-22T10:00:00.000Z',
      payload: { agentName: 'bot', event: 'open', members: ['fs', 'github'] },
    })
    expect(typeof record.id).toBe('string')
  })

  test('binds a child session to the pool by its journal session id', () => {
    // This field is the whole point of the record: without it a report can
    // see the decisions a child made but not whose pool produced them.
    const record = build({
      agentName: 'bot',
      event: 'attach',
      serverName: 'github',
      childSessionId: '01JCHILD00000000000000000B',
    })

    expect(record.payload).toEqual({
      agentName: 'bot',
      event: 'attach',
      serverName: 'github',
      childSessionId: '01JCHILD00000000000000000B',
    })
  })

  test('records a server that would not come up without refusing the pool', () => {
    // PE6: a server that did not open means less access, never a refusal of
    // the whole pool — so the fact has to be legible afterwards.
    const record = build({
      agentName: 'bot',
      event: 'attach-refused',
      serverName: 'db',
      reason: 'protocol-mismatch',
    })

    expect(record.payload).toMatchObject({ event: 'attach-refused', reason: 'protocol-mismatch' })
  })

  test('mirrors the method so the generic method filter works unchanged', () => {
    const record = build({
      agentName: 'bot',
      event: 'dropped',
      serverName: 'github',
      reason: 'server-request',
      method: 'sampling/createMessage',
    })

    expect(record.method).toBe('sampling/createMessage')
  })

  test('omits every absent optional rather than carrying an undefined key', () => {
    // "Absent, not null": an absent server is a fact about the event (a pool
    // open is about no one server), not a gap in the record.
    const record = build({ agentName: 'bot', event: 'close' })

    expect(Object.keys(record.payload as object)).toEqual(['agentName', 'event'])
    expect('method' in record).toBe(false)
    expect('durationMs' in record).toBe(false)
  })

  test('carries the names a merge hid and warned about', () => {
    const record = build({
      agentName: 'bot',
      event: 'open',
      members: ['github'],
      hiddenNames: ['github__a-very-long-name'],
      warnedNames: ['github__nearly-too-long'],
    })

    expect(record.payload).toMatchObject({
      hiddenNames: ['github__a-very-long-name'],
      warnedNames: ['github__nearly-too-long'],
    })
  })

  test('redacts a secret that reached the reason text', () => {
    // A refusal reason embeds server- and vault-influenced text, so exact
    // values the pool's upstreams were given are matched against it.
    const record = build(
      {
        agentName: 'bot',
        event: 'attach-refused',
        serverName: 'db',
        reason: 'auth failed: s3cr3t-token-value',
      },
      ['s3cr3t-token-value'],
    )

    const text = JSON.stringify(record.payload)
    expect(text).not.toContain('s3cr3t-token-value')
  })

  test('redacts a secret an upstream used as a TOOL name', () => {
    // `hiddenNames` and `warnedNames` are names the SERVER reported, not the
    // plane's own, so a hostile upstream handed a vault value could name a tool
    // after it and read it back out of the journal.
    const record = build(
      {
        agentName: 'bot',
        event: 'dropped',
        serverName: 'db',
        reason: 'name-too-long',
        hiddenNames: ['db__s3cr3t-token-value'],
        warnedNames: ['db__another-s3cr3t-value'],
      },
      ['s3cr3t-token-value', 'another-s3cr3t-value'],
    )

    const text = JSON.stringify(record.payload)
    expect(text).not.toContain('s3cr3t-token-value')
    expect(text).not.toContain('another-s3cr3t-value')
  })

  test('redacts a secret a server put in the METHOD it sent', () => {
    // A dropped server-initiated request carries the method that server chose.
    const record = build(
      {
        agentName: 'bot',
        event: 'dropped',
        serverName: 'db',
        reason: 'server-request',
        method: 'sampling/s3cr3t-token-value',
      },
      ['s3cr3t-token-value'],
    )

    expect(JSON.stringify(record.payload)).not.toContain('s3cr3t-token-value')
    // The mirrored top-level column is built from the redacted info, not the
    // raw input: a filterable field is one more place the value would surface.
    expect(record.method).not.toContain('s3cr3t-token-value')
  })

  test('does NOT match known secrets against the fields that identify the event', () => {
    // These fields are the record's subject, not its content. Matching them
    // made the trail unreadable the moment an operator put a server's own name
    // in one of its environment values — the line then said a child attached
    // to `[REDACTED]`, which is the opposite of an audit record.
    const record = build(
      {
        agentName: 'bot',
        event: 'attach',
        serverName: 'alpha',
        childSessionId: 'session-alpha',
        members: ['alpha', 'beta'],
      },
      ['alpha', 'session-alpha'],
    )

    expect(record.payload).toMatchObject({
      serverName: 'alpha',
      childSessionId: 'session-alpha',
      members: ['alpha', 'beta'],
    })
  })

  test('applies the same 8-character floor as the rest of the journal', () => {
    // A short value occurs in unrelated text constantly, so registering one
    // costs more than it protects.
    const record = build(
      { agentName: 'bot', event: 'attach-refused', serverName: 'db', reason: 'port 8080 refused' },
      ['8080'],
    )

    expect(JSON.stringify(record.payload)).toContain('8080')
  })

  test('freezes the record', () => {
    expect(Object.isFrozen(build({ agentName: 'bot', event: 'close' }))).toBe(true)
  })
})

describe('the journal vocabulary', () => {
  test('knows the pool kind', () => {
    // `JOURNAL_KINDS` reaches `journal show --kind`, the console dropdown and
    // the line validator; a kind missing here is a record nobody can filter.
    expect(JOURNAL_KINDS).toContain('pool')
  })
})
