import { expect, test } from 'vitest'
import { ancestorKeys, descendantRange, pathMatchKey } from '../../../src/files/db/path-key.js'

test('keys are normalized, trailing separators dropped, and folded on darwin and win32 only', () => {
  expect(pathMatchKey('/a/b/../c//', 'linux')).toBe('/a/c')
  expect(pathMatchKey('/', 'linux')).toBe('/')
  expect(pathMatchKey('/Data/X', 'linux')).toBe('/Data/X')
  expect(pathMatchKey('/Data/X', 'darwin')).toBe('/data/x')
  expect(pathMatchKey('C:/Data\\X\\', 'win32')).toBe('c:\\data\\x')
  expect(pathMatchKey('C:\\', 'win32')).toBe('c:\\')
})

test('ancestors run from the path up to the root', () => {
  expect(ancestorKeys('/a/b/c', 'linux')).toEqual(['/a/b/c', '/a/b', '/a', '/'])
  expect(ancestorKeys('c:\\a\\b', 'win32')).toEqual(['c:\\a\\b', 'c:\\a', 'c:\\'])
})

test('the descendant range is the separator and the next character', () => {
  expect(descendantRange('/a/b', 'linux')).toEqual({ from: '/a/b/', to: '/a/b0' })
  expect(descendantRange('/', 'linux')).toEqual({ from: '/', to: '0' })
  expect(descendantRange('c:\\a', 'win32')).toEqual({ from: 'c:\\a\\', to: 'c:\\a]' })
})
