import { describe, expect, test } from 'vitest'
import { HUB_ASSETS } from '../../hub/src/assets.js'
import { FAVICON } from '../../src/ui/assets/favicon.js'
import { SILKSCREEN_400, SILKSCREEN_700 } from '../../src/ui/assets/fonts.js'

/**
 * `hub/src/assets.ts` (plan `hub-signin-accounts`, Task 4): the hub's own
 * inlined stylesheet, font and icon, served at `GET /hub-assets/*` (Task 5).
 * No IO here — the module builds everything at import time — so these tests
 * only check the values, not a route.
 */

describe('HUB_ASSETS', () => {
  test('carries the stylesheet, both font weights and the favicon', () => {
    expect(Object.keys(HUB_ASSETS).sort()).toEqual(
      ['favicon.svg', 'hub.css', 'silkscreen-400.woff2', 'silkscreen-700.woff2'].sort(),
    )
  })

  test('reuses the console\'s font and favicon bytes byte for byte', () => {
    expect(HUB_ASSETS['silkscreen-400.woff2']?.body).toBe(SILKSCREEN_400.body)
    expect(HUB_ASSETS['silkscreen-700.woff2']?.body).toBe(SILKSCREEN_700.body)
    expect(HUB_ASSETS['favicon.svg']?.body).toBe(FAVICON.body)
  })

  test('every asset carries a strong ETag and a text/binary content type', () => {
    for (const asset of Object.values(HUB_ASSETS)) {
      expect(asset.etag).toMatch(/^"[0-9a-f]{64}"$/)
      expect(asset.contentType.length).toBeGreaterThan(0)
    }
  })

  test('hub.css is self-contained: no @import, no external url(), fonts point at /hub-assets/', () => {
    const css = String(HUB_ASSETS['hub.css']?.body ?? '')
    expect(css).not.toMatch(/@import/i)
    const urls = [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((match) => match[1] ?? '')
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(url.startsWith('/hub-assets/'), url).toBe(true)
    }
  })

  test('hub.css names no forbidden word', () => {
    const css = String(HUB_ASSETS['hub.css']?.body ?? '')
    expect(css).not.toMatch(/tamper[- ]?proof/i)
    expect(css).not.toMatch(/audit[- ]?ready/i)
  })
})
