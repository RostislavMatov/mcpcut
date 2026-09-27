import { describe, expect, test } from 'vitest'
import { accountRecordOf } from '../../hub/src/account-row.js'

/** `hub/src/account-row.ts`: a raw `accounts` row becomes an `AccountRecord` only when every column is what it should be. */

const ROW = {
  github_id: 1,
  login: 'alice',
  subdomain: 'alice',
  status: 'active',
  github_created_at: '2019-01-01T00:00:00Z',
  created_at: '2026-09-01T00:00:00.000Z',
  last_seen_at: '2026-09-02T00:00:00.000Z',
  stopped_at: null,
}

describe('accountRecordOf', () => {
  test('a well-formed row, with or without a stop mark; a bigint id is a number', () => {
    expect(accountRecordOf(ROW)).toMatchObject({ githubId: 1, stoppedAt: null })
    expect(accountRecordOf({ ...ROW, github_id: 7n, stopped_at: '2026-09-03T00:00:00.000Z' })).toMatchObject({
      githubId: 7,
      stoppedAt: '2026-09-03T00:00:00.000Z',
    })
    expect(accountRecordOf({ ...ROW, stopped_at: undefined })?.stoppedAt).toBeNull()
  })

  test.each([
    ['not an object', 'row'],
    ['null', null],
    ['an id that is text', { ...ROW, github_id: '1' }],
    ['a login that is not text', { ...ROW, login: 1 }],
    ['an unknown status', { ...ROW, status: 'gone' }],
    ['a creation date that is not text', { ...ROW, created_at: 1 }],
    ['a last-seen date that is not text', { ...ROW, last_seen_at: null }],
    ['a stop mark that is not text', { ...ROW, stopped_at: 5 }],
  ])('%s → null', (_what, row) => {
    expect(accountRecordOf(row)).toBeNull()
  })
})
