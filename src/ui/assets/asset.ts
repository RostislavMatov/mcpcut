import { createHash } from 'node:crypto'

/**
 * Static assets are inlined as TypeScript modules rather than shipped as
 * separate files (plan §Stack): `tsc` does not copy non-`.ts` files into
 * `dist/`, and adding a copy step to the build for a handful of files is more
 * risk than it removes. A useful side effect is that each asset's sha256 is
 * available at module load for both a strong `ETag` and, if ever needed, a
 * CSP hash — computed once, here.
 *
 * Text assets (stylesheet, script, SVG icon) are held as strings; binary
 * assets (the embedded pixel font, McpCut redesign) as `Buffer`s. Both flow
 * through the same digest path and the same `UiResult.body`.
 */

/** An inlined, content-addressed static asset ready to be served. */
export interface Asset {
  /** Response `Content-Type`, including charset for text. */
  readonly contentType: string
  /** The asset body, served verbatim. */
  readonly body: string | Buffer
  /** Base64 sha256 of the body — the source for a `sha256-…` CSP hash. */
  readonly sha256Base64: string
  /** Strong validator: the quoted hex sha256 of the body, for `ETag`. */
  readonly etag: string
  /** Revalidate-every-time caching; freshness is proven by the `ETag`. */
  readonly cacheControl: string
}

/**
 * Content-hashed assets are not filename-versioned (they are served at a
 * stable path), so caches must revalidate; `no-cache` + a strong `ETag`
 * yields a cheap `304` when unchanged without ever serving a stale body.
 */
const ASSET_CACHE_CONTROL = 'no-cache'

/**
 * Wraps an inlined asset body with its precomputed digests. The sha256 is
 * computed a single time and read out as both hex (ETag) and base64 (CSP).
 */
export function buildAsset(body: string | Buffer, contentType: string): Asset {
  const digest = createHash('sha256').update(body).digest()
  return {
    contentType,
    body,
    sha256Base64: digest.toString('base64'),
    etag: `"${digest.toString('hex')}"`,
    cacheControl: ASSET_CACHE_CONTROL,
  }
}
