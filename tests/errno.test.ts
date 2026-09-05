import { describe, expect, test } from 'vitest'
import { errnoCodeOf } from '../src/errno.js'

describe('errnoCodeOf', () => {
  test('returns the string code of an errno-shaped error', () => {
    // Arrange
    const error = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })

    // Act
    const code = errnoCodeOf(error)

    // Assert
    expect(code).toBe('ENOENT')
  })

  test('returns undefined for an Error without a code', () => {
    expect(errnoCodeOf(new Error('plain'))).toBeUndefined()
  })

  test('returns undefined when the code is not a string', () => {
    const error = Object.assign(new Error('numeric'), { code: 2 })

    expect(errnoCodeOf(error)).toBeUndefined()
  })

  test('returns undefined for non-object throwables', () => {
    expect(errnoCodeOf('ENOENT')).toBeUndefined()
    expect(errnoCodeOf(null)).toBeUndefined()
    expect(errnoCodeOf(undefined)).toBeUndefined()
    expect(errnoCodeOf(42)).toBeUndefined()
  })

  test('reads a code off a plain object, which is how tests model errno failures', () => {
    expect(errnoCodeOf({ code: 'EACCES' })).toBe('EACCES')
  })
})
