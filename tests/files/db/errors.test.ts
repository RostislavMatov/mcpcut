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

  test('another server, unreachable, is not sent to docker', () => {
    const error = mapPgError(pgError('ECONNREFUSED'), ctx)
    expect(error.message).toBe(
      'Postgres at db.example.com:5432 is not reachable: check that it is running and accepts connections from this machine, then `mcpcut files db status`',
    )
    expect(error.kind).toBe('unreachable')
  })

  test('the bundled container, unreachable, is told how to start it', () => {
    const bundled = `postgres://mcpcut:${encodeURIComponent(PASSWORD)}@127.0.0.1:55432/mcpcut`
    expect(mapPgError(pgError('ECONNREFUSED'), { ...ctx, url: bundled }).message).toBe(
      'Postgres at 127.0.0.1:55432 is not reachable: start it with `docker start mcpcut-postgres` (never created? `mcpcut files db init` prints the command)',
    )
  })

  test('anything but an unreachable server has the kind other', () => {
    expect(mapPgError(pgError('28000'), ctx).kind).toBe('other')
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
