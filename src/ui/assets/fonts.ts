import { buildAsset, type Asset } from './asset.js'

/**
 * The pixel display face of the McpCut console — Silkscreen by Jason Kottke,
 * SIL Open Font License 1.1 (see `LICENSE-Silkscreen-OFL.txt` beside this
 * file). Regular and Bold, latin subset, woff2 — 3.5 KB and 3.2 KB.
 *
 * Embedded rather than linked: the UI's CSP is `default-src 'none'` with a
 * per-directive `'self'` allowlist, so a Google Fonts `<link>` would simply
 * be blocked — and a self-hosted audit console must not phone a third party
 * on every page load anyway. The stylesheet declares these two faces via
 * `@font-face { src: url(/assets/silkscreen-400.woff2) }` and the CSP carries
 * `font-src 'self'` for exactly that.
 *
 * Source: https://fonts.gstatic.com/s/silkscreen/v6/ (upstream repository
 * https://github.com/googlefonts/silkscreen). Bytes are reproduced verbatim;
 * the base64 is only the transport into this module.
 */

const WOFF2_CONTENT_TYPE = 'font/woff2'

const SILKSCREEN_400_BASE64 =
  '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' +
  'oHAA'

const SILKSCREEN_700_BASE64 =
  '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'

/** Silkscreen Regular (400), latin, woff2. */
export const SILKSCREEN_400: Asset = buildAsset(
  Buffer.from(SILKSCREEN_400_BASE64, 'base64'),
  WOFF2_CONTENT_TYPE,
)

/** Silkscreen Bold (700), latin, woff2. */
export const SILKSCREEN_700: Asset = buildAsset(
  Buffer.from(SILKSCREEN_700_BASE64, 'base64'),
  WOFF2_CONTENT_TYPE,
)
