import { afterEach, beforeEach, expect, test } from 'vitest'
import { indexOnce } from '../../../src/files/search/indexer.js'
import { createFakeEmbedder } from './fake-embedder.js'
import { INDEX_RETRY_FAILED_MS } from '../../../src/files/search/constants.js'
import { createIndexFixture, NOW, ruleOn, usingEmbedder, type IndexFixture } from './index-fixture.js'
import { describePg } from '../db/pg-helpers.js'

let fx: IndexFixture
beforeEach(async () => {
  fx = await createIndexFixture()
})
afterEach(async () => {
  await fx.cleanup()
})

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nabcdefghijklmnop\n-----END PRIVATE KEY-----'

async function rowsOf(): Promise<Array<{ rel_path: string; status: string; reason: string | null }>> {
  const found = await fx.db.query<{ rel_path: string; status: string; reason: string | null }>(
    'SELECT rel_path, status, reason FROM search_files ORDER BY rel_path',
  )
  return found.rows
}

describePg('indexOnce', () => {
  test('indexes the text files in scope and stores their chunks with line numbers', async () => {
    await fx.put({ 'a.md': 'alpha beta\ngamma', 'docs/b.txt': 'delta' })
    await fx.walk()

    const result = await indexOnce(fx.sdb, fx.options())

    expect(result).toMatchObject({ indexed: 2, skipped: 0, removed: 0, pending: 0, failed: 0 })
    const chunks = await fx.db.query<{ rel_path: string; start_line: number; end_line: number; body: string }>(
      'SELECT rel_path, start_line, end_line, body FROM search_chunks ORDER BY rel_path',
    )
    expect(chunks.rows).toEqual([
      { rel_path: 'a.md', start_line: 1, end_line: 2, body: 'alpha beta\ngamma' },
      { rel_path: 'docs/b.txt', start_line: 1, end_line: 1, body: 'delta' },
    ])
    expect(fx.embedder.calls.map((call) => call.text)).toEqual(['a.md\nalpha beta\ngamma', 'docs/b.txt\ndelta'])
  })

  test('an AWS key and a private key block reach neither the stored body nor the embedder', async () => {
    await fx.put({ 'notes.md': `deploy notes\nkey ${AWS_KEY} here\n${PEM}\nthe end` })
    await fx.walk()

    await indexOnce(fx.sdb, fx.options())

    const bodies = await fx.db.query<{ body: string }>('SELECT body FROM search_chunks')
    const stored = bodies.rows.map((row) => row.body).join('\n')
    const embedded = fx.embedder.calls.map((call) => call.text).join('\n')
    for (const text of [stored, embedded]) {
      expect(text).not.toContain(AWS_KEY)
      expect(text).not.toContain('BEGIN PRIVATE KEY')
      expect(text).not.toContain('MIIEvQIBADANBg')
    }
    expect(stored).toContain('deploy notes')
  })

  test('key/value secrets and bare tokens in common formats reach neither the stored body nor the embedder', async () => {
    const yaml = 'password: "S3cr3tPassw0rd!"\nexport AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\nSECRET_KEY = "dj-key-1"\nbare 0123456789abcdef0123456789abcdef01234567\nthe password field is required'
    await fx.put({ 'conf.yml': yaml })
    await fx.walk()

    await indexOnce(fx.sdb, fx.options())

    const bodies = await fx.db.query<{ body: string }>('SELECT body FROM search_chunks')
    const stored = bodies.rows.map((row) => row.body).join('\n')
    const embedded = fx.embedder.calls.map((call) => call.text).join('\n')
    for (const text of [stored, embedded]) {
      for (const secret of ['S3cr3tPassw0rd', 'wJalrXUtnFEMI', 'dj-key-1', '0123456789abcdef0123456789abcdef']) expect(text).not.toContain(secret)
      expect(text).toContain('the password field is required')
    }
  })

  test('.env and id_rsa files are never read: skipped rows, nothing embedded', async () => {
    await fx.put({ '.env': `TOKEN=${AWS_KEY}`, 'ssh/id_rsa': PEM, 'ok.md': 'plain words' })
    await fx.walk()
    const reads: string[] = []
    const read = async (file: string, sha: string) => {
      reads.push(file)
      return (await import('../../../src/files/search/read-indexable.js')).readIndexable(file, sha)
    }

    const result = await indexOnce(fx.sdb, fx.options({ read }))

    expect(result.indexed).toBe(1)
    expect(result.skipped).toBe(2)
    expect(result.skippedByReason).toEqual({ 'secret-like name': 2 })
    expect(reads.map((file) => file.split('/').pop())).toEqual(['ok.md'])
    expect(fx.embedder.calls).toHaveLength(1)
    expect(await rowsOf()).toEqual([
      { rel_path: '.env', status: 'skipped', reason: 'secret-like name' },
      { rel_path: 'ok.md', status: 'indexed', reason: null },
      { rel_path: 'ssh/id_rsa', status: 'skipped', reason: 'secret-like name' },
    ])
  })

  test('a folder under a skipped name (.git, node_modules) is not even a row', async () => {
    await fx.put({ '.git/config': 'x', 'node_modules/p/index.js': 'y', 'z.md': 'zed' })
    await fx.walk()

    await indexOnce(fx.sdb, fx.options())

    expect((await rowsOf()).map((row) => row.rel_path)).toEqual(['z.md'])
  })

  test('a cut-out subfolder is never indexed; a rule on the subfolder is inherited', async () => {
    await fx.put({ 'a/x.md': 'one', 'a/private/y.md': 'two', 'b/z.md': 'three' })
    await fx.walk()
    const rules = [ruleOn(`${fx.root}/a`), ruleOn(`${fx.root}/a/private`, false)]

    await indexOnce(fx.sdb, fx.options({ rules }))

    expect((await rowsOf()).map((row) => row.rel_path)).toEqual(['a/x.md'])
    expect(fx.embedder.calls.map((call) => call.text).join()).not.toContain('two')
  })

  test('cutting a subfolder out later removes its rows', async () => {
    await fx.put({ 'a/x.md': 'one', 'a/private/y.md': 'two' })
    await fx.walk()
    await indexOnce(fx.sdb, fx.options())

    const result = await indexOnce(fx.sdb, fx.options({ rules: [ruleOn(fx.root), ruleOn(`${fx.root}/a/private`, false)] }))

    expect(result.removed).toBe(1)
    expect((await rowsOf()).map((row) => row.rel_path)).toEqual(['a/x.md'])
    const left = await fx.db.query('SELECT 1 FROM search_chunks WHERE rel_path = $1', ['a/private/y.md'])
    expect(left.rows).toEqual([])
  })

  test('turning the last rule off removes every row and chunk', async () => {
    await fx.put({ 'a.md': 'one', 'b.md': 'two' })
    await fx.walk()
    await indexOnce(fx.sdb, fx.options())

    const result = await indexOnce(fx.sdb, fx.options({ rules: [ruleOn(fx.root, false)] }))

    expect(result).toMatchObject({ removed: 2, indexed: 0 })
    expect(await rowsOf()).toEqual([])
    expect((await fx.db.query('SELECT 1 FROM search_chunks')).rows).toEqual([])
  })

  test('binary files and files over the limit are skipped with their reason', async () => {
    await fx.put({ 'bin.dat': Buffer.from([0x41, 0x00, 0x42]), 'big.txt': Buffer.alloc(600 * 1024, 0x61), 'ok.md': 'fine' })
    await fx.walk()

    const result = await indexOnce(fx.sdb, fx.options())

    expect(result.skippedByReason).toEqual({ binary: 1, 'too large': 1 })
    expect(await rowsOf()).toEqual([
      { rel_path: 'big.txt', status: 'skipped', reason: 'too large' },
      { rel_path: 'bin.dat', status: 'skipped', reason: 'binary' },
      { rel_path: 'ok.md', status: 'indexed', reason: null },
    ])
  })

  test('unchanged content is not embedded again; a changed file is embedded once', async () => {
    await fx.put({ 'a.md': 'first version' })
    await fx.walk()
    await indexOnce(fx.sdb, fx.options())
    const afterFirst = fx.embedder.calls.length

    await indexOnce(fx.sdb, fx.options())
    expect(fx.embedder.calls.length).toBe(afterFirst)

    await fx.put({ 'a.md': 'second version, longer' })
    await fx.walk()
    const result = await indexOnce(fx.sdb, fx.options())
    await indexOnce(fx.sdb, fx.options())

    expect(result.indexed).toBe(1)
    expect(fx.embedder.calls.length).toBe(afterFirst + 1)
    const body = await fx.db.query<{ body: string }>('SELECT body FROM search_chunks')
    expect(body.rows).toEqual([{ body: 'second version, longer' }])
  })

  test('another model embeds everything again and replaces the chunks', async () => {
    await fx.put({ 'a.md': 'same text' })
    await fx.walk()
    await indexOnce(fx.sdb, fx.options())
    const other = createFakeEmbedder('fake-embedder@2')

    const result = await indexOnce(fx.sdb, fx.options(usingEmbedder(other)))

    expect(result.indexed).toBe(1)
    expect(other.calls).toHaveLength(1)
    expect((await fx.db.query<{ model: string }>('SELECT model FROM search_files')).rows).toEqual([{ model: 'fake-embedder@2' }])
    expect((await fx.db.query('SELECT 1 FROM search_chunks')).rows).toHaveLength(1)
  })

  test('the budget leaves the rest pending, and the next round finishes it', async () => {
    await fx.put({ 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' })
    await fx.walk()
    let tick = 0
    const monotonicMs = () => (tick += 10)

    const first = await indexOnce(fx.sdb, fx.options({ budgetMs: 25, monotonicMs }))
    const second = await indexOnce(fx.sdb, fx.options())

    expect(first.indexed).toBe(2)
    expect(first.pending).toBe(1)
    expect(second).toMatchObject({ indexed: 1, pending: 0 })
  })

  test('a file gone from the catalog loses its rows', async () => {
    await fx.put({ 'a.md': 'one', 'b.md': 'two' })
    await fx.walk()
    await indexOnce(fx.sdb, fx.options())
    await (await import('node:fs/promises')).rm(`${fx.root}/b.md`)
    await fx.walk()

    const result = await indexOnce(fx.sdb, fx.options())

    expect(result.removed).toBe(1)
    expect((await rowsOf()).map((row) => row.rel_path)).toEqual(['a.md'])
  })

  test('a file that changed since the catalog hashed it is left pending, not indexed with the wrong text', async () => {
    await fx.put({ 'a.md': 'cataloged text' })
    await fx.walk()
    await fx.put({ 'a.md': 'newer text' })

    const result = await indexOnce(fx.sdb, fx.options())

    expect(result).toMatchObject({ indexed: 0, pending: 1, failed: 0 })
    expect(fx.embedder.calls).toEqual([])
  })

  test('a failing file is counted failed, the others continue, and it is retried once the retry delay has passed', async () => {
    await fx.put({ 'a.md': 'good one', 'b.md': 'poison', 'c.md': 'good two' })
    await fx.walk()
    let isPoisoned = true
    const embedder = {
      ...fx.embedder,
      embedPassage: async (text: string) => {
        if (isPoisoned && text.includes('poison')) throw new Error('model exploded')
        return fx.embedder.embedPassage(text)
      },
    }

    const first = await indexOnce(fx.sdb, fx.options(usingEmbedder(embedder)))
    isPoisoned = false
    const later = new Date(NOW.getTime() + INDEX_RETRY_FAILED_MS)
    const second = await indexOnce(fx.sdb, fx.options({ ...usingEmbedder(embedder), now: later }))

    expect(first).toMatchObject({ indexed: 2, failed: 1, firstFailure: 'b.md: model exploded' })
    expect(second).toMatchObject({ indexed: 1, failed: 0 })
  })

  test('a root no longer declared loses its rows', async () => {
    await fx.put({ 'a.md': 'one' })
    await fx.walk()
    await indexOnce(fx.sdb, fx.options())

    const result = await indexOnce(fx.sdb, fx.options({ roots: [], rules: [ruleOn(fx.root)] }))

    expect(result.removed).toBe(1)
  })

  test('only one process indexes at a time: the second gets busy and does nothing', async () => {
    await fx.put({ 'a.md': 'one' })
    await fx.walk()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slow = { ...fx.embedder, embedPassage: async (text: string) => (await gate, fx.embedder.embedPassage(text)) }
    const first = indexOnce(fx.sdb, fx.options(usingEmbedder(slow)))
    await new Promise((resolve) => setTimeout(resolve, 200))

    const second = await indexOnce(fx.sdb, fx.options())
    release()

    expect(second).toMatchObject({ busy: true, indexed: 0 })
    expect(await first).toMatchObject({ indexed: 1 })
    expect(await indexOnce(fx.sdb, fx.options())).not.toHaveProperty('busy')
  })
})
