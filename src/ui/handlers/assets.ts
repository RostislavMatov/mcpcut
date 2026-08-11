import { APP_CSS } from '../assets/app-css.js'
import { APP_JS } from '../assets/app-js.js'
import type { Asset } from '../assets/app-css.js'
import { headerValue, type UiHandler, type UiRequestContext, type UiResult } from '../routes.js'

/**
 * `GET /assets/*` handler (M4 Task 13). Serves the two inlined static assets —
 * the stylesheet and the client script — by an ALLOWLIST of known names, never
 * by a filesystem path derived from user input (sec-LOW-2, Wave-2 review).
 *
 * The route matcher (`authz.ts`) already rejects a `..` or empty segment in the
 * wildcard, but this handler is fail-closed on its own: it resolves the request
 * to one of exactly two constant `Asset` objects and answers 404 for anything
 * else. There is no `join(dir, rest)`, no `fs` read, and no way for a crafted
 * path to escape the two-entry map — the guarantee survives even if the matcher
 * were ever loosened.
 *
 * Freshness: a strong `ETag` (the asset's sha256) plus `If-None-Match` yields a
 * `304` when unchanged; otherwise `200` with the asset's own `Content-Type`,
 * `ETag` and `Cache-Control` (the server does not override these).
 */

const HTTP_STATUS_OK = 200
const HTTP_STATUS_NOT_MODIFIED = 304
const HTTP_STATUS_NOT_FOUND = 404

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
  }),
)

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
    const asset = resolveAsset(ctx.params.rest)
    if (asset === undefined) return notFound()
    return serveAsset(asset, headerValue(ctx.headers, 'if-none-match'))
  }
}
