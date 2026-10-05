import { describe, expect, test } from 'vitest'
import { FilesDbError, mapPgError, scrubPassword } from '../../../src/files/db/errors.js'

const PASSWORD = 'p@ss:w%rd'
const URL_WITH_PASSWORD = `postgres://mcpcut:${encodeURIComponent(PASSWORD)}@db.example.com:5432/mcpcut`
const ctx = { url: URL_WITH_PASSWORD, schema: 'mcpcut', cli: 'mcpcut' }

function pgError(code: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { code })
}

describe('mapPgError', () => {
  test.each(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'])('%s is not-reachable', (code) => {
    expect(mapPgError(pgError(code), ctx).message).toContain('Postgres at db.example.com:5432 is not reachable')
  })

  test('a pool timeout without a code is not-reachable', () => {
    expect(mapPgError(new Error('timeout exceeded when trying to connect'), ctx).message).toContain('is not reachable')
  })

  test('an AggregateError reads the first inner code', () => {
    const aggregate = Object.assign(new Error(''), { errors: [pgError('ECONNREFUSED')] })
    expect(mapPgError(aggregate, ctx).message).toContain('is not reachable')
  })

  test('28000 is the login line', () => {
    expect(mapPgError(pgError('28000'), ctx).message).toContain('refused the login for mcpcut')
  })

  test('42501 names the schema', () => {
    expect(mapPgError(pgError('42501'), ctx).message).toContain('may not create the schema "mcpcut"')
  })

  test('anything else carries the code and a scrubbed message', () => {
    const text = `bad: ${PASSWORD} and ${encodeURIComponent(PASSWORD)}`
    const message = mapPgError(pgError('XX000', text), ctx).message
    expect(message).toMatch(/^Postgres error XX000: bad: \*\*\* and \*\*\*$/)
  })

  test('a FilesDbError passes through unchanged', () => {
    const own = new FilesDbError('mine')
    expect(mapPgError(own, ctx)).toBe(own)
  })
})

describe('scrubPassword', () => {
  test('leaves text alone when the URL has no password', () => {
    expect(scrubPassword('hello', 'postgres://u@h/d')).toBe('hello')
  })
})
