import { describe, expect, test } from 'vitest'
import { APP_CSS } from '../../src/ui/assets/app-css.js'
import { APP_JS } from '../../src/ui/assets/app-js.js'
import { createAssetsHandler } from '../../src/ui/handlers/assets.js'
import type { UiRequestContext, UiResult } from '../../src/ui/routes.js'

/**
 * `GET /assets/*` handler (M4 Task 13). The handler resolves strictly against a
 * two-name allowlist — never a filesystem path — so `..`, absolute-ish and
 * unknown names all fail closed to 404 (sec-LOW-2). ETag/If-None-Match yields a
 * 304; a match miss yields a 200 with the asset's own headers.
 */

function ctx(rest: string | undefined, headers: Record<string, string> = {}): UiRequestContext {
  return {
    method: 'GET',
    path: '/assets/x',
    params: rest === undefined ? {} : { rest },
    query: new URLSearchParams(),
    session: undefined,
    body: Buffer.alloc(0),
    headers,
  }
}

function asResponse(result: UiResult): Extract<UiResult, { kind: 'response' }> {
  if (result.kind !== 'response') throw new Error('expected a buffered response')
  return result
}

const handler = createAssetsHandler()

describe('assets handler — allowlist resolution', () => {
  test('serves app.css with its content-type, etag, cache-control and body', async () => {
    const res = asResponse(await handler(ctx('app.css')))
    expect(res.status).toBe(200)
    expect(res.headers?.['content-type']).toBe(APP_CSS.contentType)
    expect(res.headers?.etag).toBe(APP_CSS.etag)
    expect(res.headers?.['cache-control']).toBe(APP_CSS.cacheControl)
    expect(res.body).toBe(APP_CSS.body)
  })

  test('serves app.js with its content-type and body', async () => {
    const res = asResponse(await handler(ctx('app.js')))
    expect(res.status).toBe(200)
    expect(res.headers?.['content-type']).toBe(APP_JS.contentType)
    expect(res.body).toBe(APP_JS.body)
  })

  test('an unknown asset name is 404, not a filesystem read', async () => {
    expect(asResponse(await handler(ctx('evil.js'))).status).toBe(404)
    expect(asResponse(await handler(ctx('app.css.bak'))).status).toBe(404)
  })

  test('a traversal token resolves to 404 (handler is fail-closed on its own)', async () => {
    expect(asResponse(await handler(ctx('..'))).status).toBe(404)
    expect(asResponse(await handler(ctx('../secret'))).status).toBe(404)
    expect(asResponse(await handler(ctx('/etc/passwd'))).status).toBe(404)
  })

  test('a prototype-chain key does not resolve to an asset', async () => {
    expect(asResponse(await handler(ctx('__proto__'))).status).toBe(404)
    expect(asResponse(await handler(ctx('constructor'))).status).toBe(404)
  })

  test('a missing rest param is 404', async () => {
    expect(asResponse(await handler(ctx(undefined))).status).toBe(404)
  })
})

describe('assets handler — conditional requests', () => {
  test('a matching If-None-Match yields 304 with no body but keeps validators', async () => {
    const res = asResponse(await handler(ctx('app.css', { 'if-none-match': APP_CSS.etag })))
    expect(res.status).toBe(304)
    expect(res.body).toBeUndefined()
    expect(res.headers?.etag).toBe(APP_CSS.etag)
    expect(res.headers?.['cache-control']).toBe(APP_CSS.cacheControl)
  })

  test('a stale If-None-Match yields the full 200 body', async () => {
    const res = asResponse(await handler(ctx('app.css', { 'if-none-match': '"stale"' })))
    expect(res.status).toBe(200)
    expect(res.body).toBe(APP_CSS.body)
  })
})
