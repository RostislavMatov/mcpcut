import { describe, expect, test } from 'vitest'
import { launcherOf } from '../../src/adopt/entry.js'
import { planServers, serversAt, withEntries } from '../../src/adopt/plan.js'

/** A whole config document: which entries change, and the new document built without touching the old one. */

const LAUNCHER = launcherOf('9.9.9', 'linux')

describe('serversAt', () => {
  test('follows the path to the servers object', () => {
    const doc = { projects: { '/w': { mcpServers: { fs: { command: 'x' } } } } }

    expect(serversAt(doc, ['projects', '/w', 'mcpServers'])).toEqual({ fs: { command: 'x' } })
  })

  test.each([
    ['a missing key', { other: 1 }],
    ['a list in the way', { mcpServers: [] }],
    ['a document that is not an object', 'text'],
  ])('%s gives no servers', (_label, doc) => {
    expect(serversAt(doc, ['mcpServers'])).toBeUndefined()
  })
})

describe('planServers', () => {
  test('one row per server, in the file order, with its verdict', () => {
    const servers = {
      fs: { command: 'npx', args: ['-y', 'fs-server'] },
      remote: { url: 'https://x' },
      done: { command: 'npx', args: ['-y', 'mcpcut@0.2.4', 'wrap', '--', 'x'] },
    }

    const rows = planServers(servers, LAUNCHER, 'linux')

    expect(rows.map((row) => [row.name, row.verdict.kind])).toEqual([
      ['fs', 'wrap'],
      ['remote', 'remote'],
      ['done', 'already'],
    ])
    expect(rows[0]?.before).toEqual({ command: 'npx', args: ['-y', 'fs-server'] })
  })
})

describe('withEntries', () => {
  test('replaces the named entries at the path and keeps everything else', () => {
    const doc = { numStartups: 7, projects: { '/w': { mcpServers: { a: { command: 'a' }, b: { command: 'b' } }, trust: true } } }
    const snapshot = structuredClone(doc)

    const next = withEntries(doc, ['projects', '/w', 'mcpServers'], { a: { command: 'wrapped' } })

    expect(next).toEqual({ numStartups: 7, projects: { '/w': { mcpServers: { a: { command: 'wrapped' }, b: { command: 'b' } }, trust: true } } })
    expect(doc).toEqual(snapshot)
  })

  test('a server named like an Object method is replaced only when asked', () => {
    const doc = { mcpServers: { constructor: { command: 'c' }, toString: { command: 't' } } }

    const next = withEntries(doc, ['mcpServers'], { toString: { command: 'T' } })

    expect(next).toEqual({ mcpServers: { constructor: { command: 'c' }, toString: { command: 'T' } } })
  })

  test('keeps the key order of the servers object', () => {
    const doc = { mcpServers: { a: { command: 'a' }, b: { command: 'b' }, c: { command: 'c' } } }

    const next = withEntries(doc, ['mcpServers'], { b: { command: 'B' } }) as { mcpServers: Record<string, unknown> }

    expect(Object.keys(next.mcpServers)).toEqual(['a', 'b', 'c'])
  })
})
