import { describe, expect, test } from 'vitest'
import type { UiSession } from '../../src/ui/auth.js'
import { renderNotice } from '../../src/ui/pages/notice.js'
import { plural } from '../../src/ui/pages/plural.js'

/**
 * The shared page helpers that every page family leans on: the count-and-noun
 * phrasing (U7) and the notice's per-page class lookup (U5, security L5).
 */

function session(): UiSession {
  return { adminName: 'alice', role: 'owner', csrfToken: 'csrf-token-value-123456' }
}

describe('plural', () => {
  test('a count of one keeps the singular noun', () => {
    expect(plural(1, 'group')).toBe('1 group')
  })

  test('zero and many take the plural', () => {
    expect(plural(0, 'group')).toBe('0 groups')
    expect(plural(2, 'group')).toBe('2 groups')
  })

  test('an explicit plural form wins over the default -s', () => {
    expect(plural(1, 'group', 'groups')).toBe('1 group')
    expect(plural(3, 'entry', 'entries')).toBe('3 entries')
  })
})

describe('renderNotice — the class lookup is own-property only (L5)', () => {
  test('a prototype-named backHref leaks no class into the markup', () => {
    const body = renderNotice({
      title: 'Notice',
      message: 'nothing to see',
      ok: false,
      backHref: 'constructor',
      backLabel: 'Back',
      session: session(),
    })

    expect(body).not.toContain('native code')
    expect(body).not.toContain('function Object')
    expect(body).toContain('class="notice error "')
  })

  test('a known backHref still gets its page-family class', () => {
    const body = renderNotice({
      title: 'Groups',
      message: 'done',
      ok: true,
      backHref: '/groups',
      backLabel: 'Back to groups',
      session: session(),
    })

    expect(body).toContain('gr-notice')
  })
})
