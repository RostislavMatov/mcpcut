import { describe, expect, test } from 'vitest'
import { parseAgentsFile } from '../../src/agents/schema.js'

/**
 * M4 Task 6: the grant dictionary grows optional `resources`/`prompts`
 * fields. These tests pin (1) backward compatibility — every pre-M4
 * `agents.json` still parses, byte-identical semantics — and (2) the
 * validation of the new pattern shapes. The pre-existing schema surface is
 * pinned by `schema.test.ts`, which this file deliberately does not touch.
 */

const HASH = 'a'.repeat(64)
const CREATED = '2026-08-05T10:00:00.000Z'

function fileWithGrant(grant: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    agents: {
      'research-bot': {
        name: 'research-bot',
        tokenHash: HASH,
        createdAt: CREATED,
        grants: { github: grant },
      },
    },
  }
}

describe('parseAgentsFile: pre-M4 files (no resources/prompts) still parse', () => {
  test('a tools-only grant parses and the new fields stay absent', () => {
    const result = parseAgentsFile(fileWithGrant({ tools: ['get_*'] }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      const grant = result.file.agents['research-bot']?.grants['github']
      expect(grant?.tools).toEqual(['get_*'])
      expect(grant?.resources).toBeUndefined()
      expect(grant?.prompts).toBeUndefined()
    }
  })
})

describe('parseAgentsFile: accepted resources/prompts shapes', () => {
  test('resources as URI patterns and prompts as name patterns round-trip', () => {
    const result = parseAgentsFile(
      fileWithGrant({
        tools: '*',
        resources: ['file:///project/*', 'doc://handbook'],
        prompts: ['greet*', 'summary'],
      }),
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      const grant = result.file.agents['research-bot']?.grants['github']
      expect(grant?.resources).toEqual(['file:///project/*', 'doc://handbook'])
      expect(grant?.prompts).toEqual(['greet*', 'summary'])
    }
  })

  test("resources: '*' and prompts: '*' literals parse", () => {
    const result = parseAgentsFile(fileWithGrant({ tools: [], resources: '*', prompts: '*' }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      const grant = result.file.agents['research-bot']?.grants['github']
      expect(grant?.resources).toBe('*')
      expect(grant?.prompts).toBe('*')
    }
  })

  test('empty arrays parse (equivalent to absent at scope level)', () => {
    expect(parseAgentsFile(fileWithGrant({ tools: [], resources: [], prompts: [] })).ok).toBe(true)
  })
})

describe('parseAgentsFile: rejected resources/prompts shapes', () => {
  test.each([
    ['a bare string that is not the * literal', { tools: [], resources: 'file:///x' }],
    ['a resource pattern with whitespace', { tools: [], resources: ['file:///a b'] }],
    ['a resource pattern with an embedded *', { tools: [], resources: ['file:///a*b'] }],
    ['a resource pattern with two trailing *', { tools: [], resources: ['file:///a**'] }],
    ['an empty resource pattern', { tools: [], resources: [''] }],
    ['a lone * as an array element (use the literal instead)', { tools: [], resources: ['*'] }],
    ['a resource pattern with a control character', { tools: [], resources: ['file:///a\u0007b'] }],
    ['a reserved name as a resource pattern', { tools: [], resources: ['__proto__'] }],
    ['a prompt pattern with a slash', { tools: [], prompts: ['bad/name'] }],
    ['a prompt pattern with whitespace', { tools: [], prompts: ['bad name'] }],
    ['a reserved name as a prompt pattern', { tools: [], prompts: ['constructor'] }],
    ['a non-string resource entry', { tools: [], resources: [42] }],
  ])('%s is rejected', (_label, grant) => {
    expect(parseAgentsFile(fileWithGrant(grant)).ok).toBe(false)
  })

  test('an oversized resource pattern is rejected', () => {
    const huge = `file:///${'a'.repeat(3000)}`

    expect(parseAgentsFile(fileWithGrant({ tools: [], resources: [huge] })).ok).toBe(false)
  })
})
