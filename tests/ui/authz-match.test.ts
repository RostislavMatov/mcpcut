import { describe, expect, test } from 'vitest'
import { matchRoute } from '../../src/ui/authz.js'

/**
 * `matchRoute` wildcard hardening (sec-LOW-2): the `/assets/*` matcher must
 * fail-closed on path-traversal tokens so a Wave-3 asset handler can never
 * receive a `rest` that climbs out of the asset root — even if written naively.
 */
describe('matchRoute: /assets/* wildcard', () => {
  test('matches a plain asset path and captures the rest', () => {
    const match = matchRoute('GET', '/assets/app.js')
    expect(match?.entry.handler).toBe('assets')
    expect(match?.params.rest).toBe('app.js')
  })

  test('matches a nested asset path', () => {
    const match = matchRoute('GET', '/assets/img/logo.png')
    expect(match?.params.rest).toBe('img/logo.png')
  })

  test('refuses a `..` traversal segment (fail-closed → no match → 403)', () => {
    expect(matchRoute('GET', '/assets/..')).toBeNull()
    expect(matchRoute('GET', '/assets/../secret')).toBeNull()
    expect(matchRoute('GET', '/assets/img/../../etc/passwd')).toBeNull()
  })

  test('refuses an empty segment (double slash)', () => {
    expect(matchRoute('GET', '/assets//app.js')).toBeNull()
  })

  test('refuses a bare /assets with nothing after the wildcard', () => {
    expect(matchRoute('GET', '/assets')).toBeNull()
  })
})
