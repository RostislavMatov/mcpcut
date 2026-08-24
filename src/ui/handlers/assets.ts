import { APP_CSS } from '../assets/app-css.js'
import { APP_JS } from '../assets/app-js.js'
import { DASHBOARD_JS } from '../assets/dashboard-js.js'
import { SERVERS_JS } from '../assets/servers-js.js'
import type { Asset } from '../assets/asset.js'
import { FAVICON } from '../assets/favicon.js'
import { LOGIN_JS } from '../assets/login-js.js'
import { SILKSCREEN_400, SILKSCREEN_700 } from '../assets/fonts.js'
import {
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_NOT_MODIFIED,
  HTTP_STATUS_OK,
} from '../constants.js'
import { headerValue, type UiHandler, type UiRequestContext, type UiResult } from '../routes.js'

/**
 * `GET /assets/*` handler (M4 Task 13). Serves the inlined static assets —
 * the stylesheet, the client script, the icon and the two embedded pixel-font
 * faces — by an ALLOWLIST of known names, never by a filesystem path derived
 * from user input (sec-LOW-2, Wave-2 review).
 *
 * The route matcher (`authz.ts`) already rejects a `..` or empty segment in the
 * wildcard, but this handler is fail-closed on its own: it resolves the request
 * to one of a handful of constant `Asset` objects and answers 404 for anything
 * else. There is no `join(dir, rest)`, no `fs` read, and no way for a crafted
 * path to escape the fixed map — the guarantee survives even if the matcher
 * were ever loosened.
 *
 * Freshness: a strong `ETag` (the asset's sha256) plus `If-None-Match` yields a
 * `304` when unchanged; otherwise `200` with the asset's own `Content-Type`,
 * `ETag` and `Cache-Control` (the server does not override these).
 */

const CONTENT_TYPE_TEXT = 'text/plain; charset=utf-8'

/**
 * The fixed asset allowlist: request rest → constant asset. A `null`-prototype
 * object so a hostile `rest` such as `__proto__` reads as "absent" rather than
 * resolving up the prototype chain.
 */
const ASSETS: Readonly<Record<string, Asset>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, Asset>, {
    'app.css': APP_CSS,
    'app.js': APP_JS,
    'login.js': LOGIN_JS,
    'dashboard.js': DASHBOARD_JS,
    'servers.js': SERVERS_JS,
    'favicon.svg': FAVICON,
    'silkscreen-400.woff2': SILKSCREEN_400,
    'silkscreen-700.woff2': SILKSCREEN_700,
  }),
)

/**
 * Well-known paths a browser probes on its own, mapped to an allowlist NAME.
 * `/favicon.ico` is the only one: the browser asks for it unprompted, and
 * without a route deny-by-default answered 403 into the console of every page
 * (manual M4 smoke). The alias is an exact-path lookup into the SAME two-step
 * allowlist — it resolves to a name, never to a path, so it opens no second
 * resolution channel.
 */
const PATH_ALIASES: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    '/favicon.ico': 'favicon.svg',
  }),
)

/** The allowlist name for a request: the wildcard segment, or a path alias. */
function assetNameFor(ctx: UiRequestContext): string | undefined {
  if (ctx.params.rest !== undefined) return ctx.params.rest
  return Object.hasOwn(PATH_ALIASES, ctx.path) ? PATH_ALIASES[ctx.path] : undefined
}

/** Looks up an asset by exact name, using an own-property check (no chain). */
function resolveAsset(rest: string | undefined): Asset | undefined {
  if (rest === undefined || !Object.hasOwn(ASSETS, rest)) return undefined
  return ASSETS[rest]
}

function notFound(): UiResult {
  return {
    kind: 'response',
    status: HTTP_STATUS_NOT_FOUND,
    headers: { 'content-type': CONTENT_TYPE_TEXT },
    body: 'not found',
  }
}

function serveAsset(asset: Asset, ifNoneMatch: string | undefined): UiResult {
  if (ifNoneMatch !== undefined && ifNoneMatch === asset.etag) {
    return {
      kind: 'response',
      status: HTTP_STATUS_NOT_MODIFIED,
      headers: { etag: asset.etag, 'cache-control': asset.cacheControl },
    }
  }
  return {
    kind: 'response',
    status: HTTP_STATUS_OK,
    headers: {
      'content-type': asset.contentType,
      etag: asset.etag,
      'cache-control': asset.cacheControl,
    },
    body: asset.body,
  }
}

/** Builds the injectable `assets` handler. Pure over its constant allowlist. */
export function createAssetsHandler(): UiHandler {
  return function assets(ctx: UiRequestContext): UiResult {
    const asset = resolveAsset(assetNameFor(ctx))
    if (asset === undefined) return notFound()
    return serveAsset(asset, headerValue(ctx.headers, 'if-none-match'))
  }
}
