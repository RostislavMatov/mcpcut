import { describe, expect, test } from 'vitest'
import {
  POOL_SERVER_INFO_NAME,
  POOL_UPSTREAM_CLIENT_NAME,
} from '../../src/pool/constants.js'
import {
  buildUpstreamInitialize,
  negotiatePoolVersion,
  readRequestedVersion,
  readUpstreamInitializeReply,
  synthesizeInitializeResult,
  UPSTREAM_INITIALIZED_LINE,
} from '../../src/pool/initialize.js'
import { SESSIONFUL_PROTOCOL_VERSIONS } from '../../src/protocol/mcp.js'

const LATEST = SESSIONFUL_PROTOCOL_VERSIONS[SESSIONFUL_PROTOCOL_VERSIONS.length - 1]!

function initializeResult(result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, result })
}

function parsedLine(bytes: Buffer): Record<string, unknown> {
  return JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
}

describe('negotiatePoolVersion', () => {
  test.each(SESSIONFUL_PROTOCOL_VERSIONS.map((version) => [version]))(
    'echoes the supported revision %s back',
    (version) => {
      expect(negotiatePoolVersion(version)).toBe(version)
    },
  )

  test.each([
    ['the stateless revision, which has no initialize', '2026-07-28'],
    ['an ancient revision', '1999-01-01'],
    ['a number', 42],
    ['nothing at all', undefined],
    ['null', null],
    ['an object', { protocolVersion: '2025-06-18' }],
    ['an empty string', ''],
  ])('falls back to the latest supported revision for %s', (_label, requested) => {
    expect(negotiatePoolVersion(requested)).toBe(LATEST)
  })
})

describe('readRequestedVersion', () => {
  test('reads params.protocolVersion', () => {
    const raw = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} },
    })

    expect(readRequestedVersion(raw)).toBe('2025-06-18')
  })

  test.each([
    ['unparseable JSON', '{not json'],
    ['params that are not an object', JSON.stringify({ params: 'nope' })],
    ['no params at all', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })],
  ])('yields undefined for %s', (_label, raw) => {
    expect(readRequestedVersion(raw)).toBeUndefined()
  })

  test('hands a non-string version through unchanged, for negotiate to reject', () => {
    expect(readRequestedVersion(JSON.stringify({ params: { protocolVersion: 7 } }))).toBe(7)
  })
})

describe('synthesizeInitializeResult', () => {
  test('answers as the plane itself, not as any upstream', () => {
    const parsed = parsedLine(synthesizeInitializeResult(1, '2025-06-18', '0.1.0'))

    expect(parsed).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } },
        serverInfo: { name: POOL_SERVER_INFO_NAME, version: '0.1.0' },
      },
    })
  })

  test('declares nothing outside the first-version scope (PE3)', () => {
    const parsed = parsedLine(synthesizeInitializeResult(1, '2025-06-18', '0.1.0')) as {
      result: Record<string, unknown>
    }

    expect(Object.keys(parsed.result.capabilities as object).sort()).toEqual(['prompts', 'tools'])
    expect(parsed.result).not.toHaveProperty('instructions')
  })

  test('negotiates the version rather than echoing whatever was asked', () => {
    const parsed = parsedLine(synthesizeInitializeResult(1, '2026-07-28', '0.1.0')) as {
      result: { protocolVersion: string }
    }

    expect(parsed.result.protocolVersion).toBe(LATEST)
  })

  test('ends with a newline, ready to write to the client', () => {
    expect(synthesizeInitializeResult('x', undefined, '0.1.0').toString('utf8').endsWith('}\n')).toBe(true)
  })
})

describe('buildUpstreamInitialize', () => {
  test('offers the upstream NO client capabilities at all (PE3 load-bearing)', () => {
    const parsed = JSON.parse(buildUpstreamInitialize('mcpcut-pool:1', '2025-06-18', '0.1.0')) as {
      params: { capabilities: unknown }
    }

    expect(parsed.params.capabilities).toEqual({})
  })

  test('presents the plane as the client, with the asked-for revision', () => {
    const parsed = JSON.parse(buildUpstreamInitialize('mcpcut-pool:1', '2025-06-18', '0.1.0'))

    expect(parsed).toEqual({
      jsonrpc: '2.0',
      id: 'mcpcut-pool:1',
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: POOL_UPSTREAM_CLIENT_NAME, version: '0.1.0' },
      },
    })
  })

  test('carries no framing newline of its own', () => {
    expect(buildUpstreamInitialize('mcpcut-pool:1', '2025-06-18', '0.1.0')).not.toContain('\n')
  })
})

describe('UPSTREAM_INITIALIZED_LINE', () => {
  test('is the bare initialized notification, with no id and no newline', () => {
    expect(JSON.parse(UPSTREAM_INITIALIZED_LINE)).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })
    expect(UPSTREAM_INITIALIZED_LINE).not.toContain('\n')
  })
})

describe('readUpstreamInitializeReply', () => {
  test('reports the revision and which of the two catalogs the server offers', () => {
    const raw = initializeResult({
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: true }, prompts: {} },
      serverInfo: { name: 'gh', version: '1' },
    })

    expect(readUpstreamInitializeReply(raw)).toEqual({
      kind: 'sessionful',
      info: { protocolVersion: '2025-06-18', hasTools: true, hasPrompts: true },
    })
  })

  test('a server offering neither catalog is still a server that came up', () => {
    const raw = initializeResult({ protocolVersion: '2025-11-25', capabilities: {} })

    expect(readUpstreamInitializeReply(raw)).toEqual({
      kind: 'sessionful',
      info: { protocolVersion: '2025-11-25', hasTools: false, hasPrompts: false },
    })
  })

  test('a capability that is not an object does not count as the catalog', () => {
    const raw = initializeResult({ protocolVersion: '2025-11-25', capabilities: { tools: true } })

    const reply = readUpstreamInitializeReply(raw)
    expect(reply.kind === 'sessionful' && reply.info.hasTools).toBe(false)
  })

  test('a revision the plane has no handshake for is named, for the caller to ask `server/discover`', () => {
    // RV2: every fixture in this repository once answered `initialize` with
    // 2026-07-28 — a revision with no handshake. It is not a server that is
    // down; it is one to ask again the new way.
    const raw = initializeResult({ protocolVersion: '2026-07-28', capabilities: {} })

    expect(readUpstreamInitializeReply(raw)).toEqual({ kind: 'other-revision', protocolVersion: '2026-07-28' })
  })

  test('an error response is an error, not garbage: the caller falls back to discover', () => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32022, message: 'no' } })

    expect(readUpstreamInitializeReply(raw)).toEqual({ kind: 'error' })
  })

  test.each([
    ['a revision that is not a string', initializeResult({ protocolVersion: 7, capabilities: {} })],
    ['no protocolVersion at all', initializeResult({ capabilities: {} })],
    ['a result that is not an object', initializeResult('ok')],
    ['unparseable JSON', '{not json'],
  ])('reads %s as unreadable (PE6)', (_label, raw) => {
    expect(readUpstreamInitializeReply(raw)).toEqual({ kind: 'unreadable' })
  })

  test('missing capabilities read as no catalogs, not as a failure', () => {
    expect(readUpstreamInitializeReply(initializeResult({ protocolVersion: '2025-03-26' }))).toEqual({
      kind: 'sessionful',
      info: { protocolVersion: '2025-03-26', hasTools: false, hasPrompts: false },
    })
  })
})
