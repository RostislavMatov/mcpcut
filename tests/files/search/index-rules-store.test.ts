import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { INDEX_RULES_MAX } from '../../../src/files/search/constants.js'
import { IndexRulesLimitError, createIndexRulesStore, parseIndexRulesFile } from '../../../src/files/search/index-rules-store.js'

let journalDir: string
const clock = (): Date => new Date('2026-10-05T10:00:00.000Z')

beforeEach(async () => {
  journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-index-rules-'))
})

afterEach(async () => {
  await rm(journalDir, { recursive: true, force: true })
})

describe('index rules store', () => {
  test('lists nothing on a fresh install', async () => {
    expect(await createIndexRulesStore({ journalDir }).list()).toEqual([])
  })

  test('set persists the rule and survives a new store instance', async () => {
    await createIndexRulesStore({ journalDir, clock }).set('/data/a', true)

    const rules = await createIndexRulesStore({ journalDir }).list()

    expect(rules).toEqual([{ path: '/data/a', enabled: true, setAt: '2026-10-05T10:00:00.000Z' }])
  })

  test('set on the same path replaces the rule and keeps one entry', async () => {
    const store = createIndexRulesStore({ journalDir, clock })
    await store.set('/data/a', true)

    await store.set('/data/a', false)

    expect(await store.list()).toEqual([{ path: '/data/a', enabled: false, setAt: '2026-10-05T10:00:00.000Z' }])
  })

  test('list is sorted by path', async () => {
    const store = createIndexRulesStore({ journalDir, clock })
    await store.set('/data/b', true)
    await store.set('/data/a', true)

    expect((await store.list()).map((rule) => rule.path)).toEqual(['/data/a', '/data/b'])
  })

  test('remove reports whether the rule existed', async () => {
    const store = createIndexRulesStore({ journalDir, clock })
    await store.set('/data/a', true)

    expect(await store.remove('/data/a')).toEqual({ removed: true })
    expect(await store.remove('/data/a')).toEqual({ removed: false })
    expect(await store.list()).toEqual([])
  })

  test('refuses a rule past the limit, but still replaces an existing one', async () => {
    const store = createIndexRulesStore({ journalDir, clock })
    for (let index = 0; index < INDEX_RULES_MAX; index += 1) await store.set(`/data/${index}`, true)

    await expect(store.set('/data/extra', true)).rejects.toBeInstanceOf(IndexRulesLimitError)
    await expect(store.set('/data/0', false)).resolves.toBeUndefined()
  })

  test('parse refuses a relative path, a duplicate path and an unknown field', () => {
    const rule = { path: '/a', enabled: true, setAt: '2026-10-05T10:00:00.000Z' }

    expect(parseIndexRulesFile({ version: 1, rules: [rule] }).ok).toBe(true)
    expect(parseIndexRulesFile({ version: 1, rules: [{ ...rule, path: 'a' }] }).ok).toBe(false)
    expect(parseIndexRulesFile({ version: 1, rules: [rule, rule] }).ok).toBe(false)
    expect(parseIndexRulesFile({ version: 1, rules: [{ ...rule, extra: 1 }] }).ok).toBe(false)
  })
})
