import { describe, expect, test } from 'vitest'
import {
  GROUPS_LIST,
  refusalNotice,
  SERVERS_LIST,
  UNKNOWN_SERVER_MESSAGE,
} from '../../src/ui/handlers/refusal-notice.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'

/**
 * A refused form post a person can act on (owner's rule 2026-09-29): what
 * happened in one line, and the link back to the list it came from — instead
 * of the bare `unknown server` text a browser used to show on a blank page.
 */

function ctx(session?: UiRequestContext['session']): UiRequestContext {
  return {
    method: 'POST',
    path: '/servers/remove',
    params: {},
    query: new URLSearchParams(),
    ...(session !== undefined ? { session } : {}),
    body: Buffer.alloc(0),
    headers: {},
  }
}

function asResponse(result: UiResult): Extract<UiResult, { kind: 'response' }> {
  if (result.kind !== 'response') throw new Error('expected a buffered response')
  return result
}

const OWNER = { adminName: 'alice', role: 'owner' as const, csrfToken: 'csrf' }

describe('refusalNotice', () => {
  test('with a session: an HTML notice with the message and the way back, status kept', () => {
    const res = asResponse(refusalNotice(ctx(OWNER), 404, UNKNOWN_SERVER_MESSAGE, SERVERS_LIST))
    expect(res.status).toBe(404)
    expect(res.headers?.['content-type']).toMatch(/^text\/html/)
    expect(String(res.body)).toContain('That server is not registered')
    expect(String(res.body)).toContain('<a href="/servers">Back to servers</a>')
  })

  test('the groups target leads back to groups', () => {
    const res = asResponse(refusalNotice(ctx(OWNER), 404, 'x', GROUPS_LIST))
    expect(String(res.body)).toContain('<a href="/groups">Back to groups</a>')
  })

  test('the message is escaped', () => {
    const res = asResponse(refusalNotice(ctx(OWNER), 400, '<b>x</b>', SERVERS_LIST))
    expect(String(res.body)).toContain('&lt;b&gt;x&lt;/b&gt;')
  })

  test('without a session (impossible behind the route table) it stays plain text', () => {
    const res = asResponse(refusalNotice(ctx(), 404, UNKNOWN_SERVER_MESSAGE, SERVERS_LIST))
    expect(res.body).toBe(UNKNOWN_SERVER_MESSAGE)
  })
})
