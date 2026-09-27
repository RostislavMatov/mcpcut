import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { HUB_ASSETS } from '../../hub/src/assets.js'
import { startHub, type HubHarness } from './harness.js'

/**
 * The request pipeline of `hub/src/server.ts` (plan Task 5): Host → Origin
 * (POST) → route → session → CSRF → handler, the headers every answer
 * carries, the static assets, `/healthz`, and the listener's timeouts.
 */

let hub: HubHarness

beforeEach(async () => {
  hub = await startHub()
})

afterEach(async () => {
  await hub.close()
})

describe('screening', () => {
  test('a foreign Host is refused before anything else', async () => {
    const response = await hub.request('GET', '/terms', { host: 'evil.example' })

    expect(response.status).toBe(403)
  })

  test('a localhost Host is refused too: only the public host is served', async () => {
    const response = await hub.request('GET', '/terms', { host: `127.0.0.1:${hub.port}` })

    expect(response.status).toBe(403)
  })

  test('a missing Host is refused', async () => {
    const response = await hub.request('GET', '/terms', { host: '' })

    expect(response.status).toBe(403)
  })

  test('the public Host is matched case-insensitively', async () => {
    const response = await hub.request('GET', '/terms', { host: 'MCPCUT.test' })

    expect(response.status).toBe(200)
  })

  test('a POST from a foreign Origin is refused', async () => {
    const response = await hub.request('POST', '/signout', { origin: 'https://evil.example', form: {} })

    expect(response.status).toBe(403)
  })

  test('a POST without an Origin is refused', async () => {
    const response = await hub.request('POST', '/signout', { origin: null, form: {} })

    expect(response.status).toBe(403)
  })

  test('a POST from a sibling subdomain is refused (exact origin, not the parent domain)', async () => {
    const response = await hub.request('POST', '/signout', { origin: 'https://alice.mcpcut.test', form: {} })

    expect(response.status).toBe(403)
  })

  test('a GET carrying a foreign Origin is refused', async () => {
    const response = await hub.request('GET', '/terms', { origin: 'https://evil.example' })

    expect(response.status).toBe(403)
  })

  test('an unknown path is a 404 page', async () => {
    const response = await hub.request('GET', '/wp-admin')

    expect(response.status).toBe(404)
    expect(response.body).toContain('Not found')
  })

  test('a known path with the wrong method is a 404', async () => {
    const response = await hub.request('DELETE', '/account')

    expect(response.status).toBe(404)
  })

  test('an oversized body is refused with 413', async () => {
    const response = await hub.request('POST', '/signout', { form: { pad: 'x'.repeat(64 * 1024) } })

    expect(response.status).toBe(413)
  })
})

describe('headers', () => {
  test('every answer carries the security headers, HSTS included, and no-store', async () => {
    for (const path of ['/terms', '/nope', '/signin']) {
      const response = await hub.request('GET', path)

      expect(response.headers['content-security-policy']).toContain("default-src 'none'")
      expect(response.headers['x-content-type-options']).toBe('nosniff')
      expect(response.headers['referrer-policy']).toBe('same-origin')
      expect(response.headers['x-frame-options']).toBe('DENY')
      expect(response.headers['strict-transport-security']).toContain('max-age=')
      expect(response.headers['cache-control']).toBe('no-store')
    }
  })

  test('refusals carry the security headers too', async () => {
    const response = await hub.request('GET', '/terms', { host: 'evil.example' })

    expect(response.headers['content-security-policy']).toContain("default-src 'none'")
  })
})

describe('/healthz', () => {
  test('answers ok whatever the Host, so a container healthcheck can reach it', async () => {
    const response = await hub.request('GET', '/healthz', { host: `127.0.0.1:${hub.port}` })

    expect(response.status).toBe(200)
    expect(response.body).toBe('ok\n')
  })
})

describe('/hub-assets', () => {
  test('serves the stylesheet with its ETag and cache policy', async () => {
    const response = await hub.request('GET', '/hub-assets/hub.css')
    const asset = HUB_ASSETS['hub.css']

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe(asset?.contentType)
    expect(response.headers.etag).toBe(asset?.etag)
    expect(response.headers['cache-control']).toBe('no-cache')
  })

  test('answers 304 to a matching If-None-Match', async () => {
    const etag = HUB_ASSETS['hub.css']?.etag ?? ''

    const response = await hub.request('GET', '/hub-assets/hub.css', { headers: { 'if-none-match': etag } })

    expect(response.status).toBe(304)
    expect(response.body).toBe('')
  })

  test('an unknown or prototype-named asset is a 404', async () => {
    for (const name of ['nope.css', 'constructor', '__proto__', '..%2Fhub.db']) {
      const response = await hub.request('GET', `/hub-assets/${name}`)

      expect(response.status).toBe(404)
    }
  })
})

describe('failures', () => {
  test('a dead session cookie on a public page is cleared, the page still served', async () => {
    const response = await hub.request('GET', '/terms', { cookie: `__Host-mcpcut_hub=${'q'.repeat(43)}` })

    expect(response.status).toBe(200)
    expect(String(response.headers['set-cookie'])).toContain('__Host-mcpcut_hub=;')
  })

  test('a handler that throws is a 500 with the security headers, logged by class and message', async () => {
    const throwing = await startHub({
      orchestrator: {
        get available(): boolean {
          throw new Error('orchestrator exploded')
        },
        create: () => Promise.reject(new Error('unused')),
        rotateOwnerToken: () => Promise.reject(new Error('unused')),
        remove: () => Promise.reject(new Error('unused')),
      },
    })
    try {
      const response = await throwing.browser().signIn()

      expect(response.status).toBe(500)
      expect(response.headers['content-security-policy']).toContain("default-src 'none'")
      expect(throwing.logs.join('\n')).toContain('request handler failed: Error: orchestrator exploded')
    } finally {
      await throwing.close()
    }
  })

  test('listening on a port already taken rejects', async () => {
    const { createHubServer } = await import('../../hub/src/server.js')
    const second = createHubServer({
      config: { publicUrl: 'https://mcpcut.test', tenantDomain: 'mcpcut.com', maxAccounts: 1, minAccountAgeDays: 30, signupsPerHourPerIp: 3, trustCfConnectingIp: false },
      db: hub.db,
      github: { authorizeUrl: () => '', exchangeCode: async () => '', fetchProfile: async () => ({ id: 1, login: 'a', createdAt: '' }), revokeToken: async () => undefined, close: () => undefined },
      orchestrator: hub.orchestrator,
    })

    await expect(second.listen(hub.port, '127.0.0.1')).rejects.toThrow()
    await second.close()
  })

  test('sessionCount follows sign-ins', async () => {
    expect(hub.server.sessionCount()).toBe(0)
    await hub.browser().signIn()
    expect(hub.server.sessionCount()).toBe(1)
  })
})

describe('listener', () => {
  test('sets explicit connection timeouts, headers within the request budget', () => {
    const timeouts = hub.server.connectionTimeouts()

    expect(timeouts).not.toBeNull()
    expect(timeouts?.headersTimeoutMs).toBeLessThanOrEqual(timeouts?.requestTimeoutMs ?? 0)
    expect(timeouts?.requestTimeoutMs).toBeLessThanOrEqual(60_000)
  })

  test('close is idempotent', async () => {
    await hub.server.close()
    await expect(hub.server.close()).resolves.toBeUndefined()
    expect(hub.server.connectionTimeouts()).toBeNull()
  })
})
