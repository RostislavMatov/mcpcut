import { expect, test } from 'vitest'
import { prefixOf, ruleKeysOf } from '../../../src/files/search/search-query.js'

test('rules on the same folder are merged: ops add up, an empty one wins the tie', () => {
  const keys = ruleKeysOf(
    [
      { path: '/data/a', ops: ['read'] },
      { path: '/data/a/', ops: ['write'] },
      { path: '/data/a/private', ops: ['read'] },
      { path: '/data/a/private', ops: [] },
    ],
    'linux',
  )

  expect(keys).toEqual([
    { key: '/data/a', prefix: '/data/a/', depth: 2, can_read: true },
    { key: '/data/a/private', prefix: '/data/a/private/', depth: 3, can_read: false },
  ])
})

test('a key that already ends with the separator gets no second one', () => {
  expect(prefixOf('/', 'linux')).toBe('/')
  expect(prefixOf('c:\\', 'win32')).toBe('c:\\')
  expect(prefixOf('/data', 'linux')).toBe('/data/')
  expect(ruleKeysOf([{ path: '/', ops: ['read'] }], 'linux')).toEqual([{ key: '/', prefix: '/', depth: 0, can_read: true }])
})

test('on Windows the keys are folded and compared with backslashes', () => {
  const keys = ruleKeysOf([{ path: 'C:\\Data\\Reports', ops: ['read'] }], 'win32')

  expect(keys).toEqual([{ key: 'c:\\data\\reports', prefix: 'c:\\data\\reports\\', depth: 3, can_read: true }])
})
