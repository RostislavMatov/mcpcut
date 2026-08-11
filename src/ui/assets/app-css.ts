import { createHash } from 'node:crypto'

/**
 * Static assets are inlined as TypeScript string modules rather than shipped
 * as separate files (plan §Stack): `tsc` does not copy non-`.ts` files into
 * `dist/`, and adding a copy step to the build for two files is more risk
 * than it removes. A useful side effect is that each asset's sha256 is
 * available at module load for both a strong `ETag` and, if ever needed, a
 * CSP hash — computed once, here.
 *
 * The `buildAsset` helper lives in this module (the base stylesheet asset)
 * and is imported by `app-js.ts` so the digest/ETag logic is written once.
 */

/** An inlined, content-addressed static asset ready to be served. */
export interface Asset {
  /** Response `Content-Type`, including charset. */
  readonly contentType: string
  /** The asset body, served verbatim. */
  readonly body: string
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
export function buildAsset(body: string, contentType: string): Asset {
  const digest = createHash('sha256').update(body, 'utf8').digest()
  return {
    contentType,
    body,
    sha256Base64: digest.toString('base64'),
    etag: `"${digest.toString('hex')}"`,
    cacheControl: ASSET_CACHE_CONTROL,
  }
}

/**
 * Self-contained stylesheet: no `@import`, no external font, no CDN URL — the
 * UI's CSP is `default-src 'none'; style-src 'self'`, so anything off-origin
 * would simply be blocked. Kept deliberately small and semantic; page-level
 * structure comes from the server-rendered HTML.
 */
const APP_CSS_SOURCE = `:root {
  color-scheme: light dark;
  --bg: #0f1115;
  --panel: #171a21;
  --fg: #e6e6e6;
  --muted: #9aa4b2;
  --accent: #4f8cff;
  --danger: #ff5c5c;
  --ok: #37c871;
  --border: #262b34;
  --radius: 8px;
  --gap: 12px;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  line-height: 1.5;
}

header.app-nav {
  display: flex;
  align-items: center;
  gap: var(--gap);
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

header.app-nav a {
  color: var(--fg);
  text-decoration: none;
  padding: 6px 10px;
  border-radius: var(--radius);
}

header.app-nav a[aria-current="page"] {
  background: var(--accent);
  color: #fff;
}

header.app-nav .spacer { flex: 1; }

header.app-nav .whoami {
  color: var(--muted);
  font-size: 0.9rem;
}

main {
  max-width: 1024px;
  margin: 0 auto;
  padding: 20px 16px 64px;
}

h1, h2, h3 { line-height: 1.25; }

.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  margin-bottom: var(--gap);
}

.muted { color: var(--muted); }

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.8rem;
  border: 1px solid var(--border);
}

.badge.write, .badge.destructive { color: var(--danger); border-color: var(--danger); }
.badge.read { color: var(--ok); border-color: var(--ok); }

button {
  font: inherit;
  padding: 8px 14px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}

button.secondary { background: transparent; color: var(--fg); }
button.danger { background: var(--danger); }
button[disabled] { opacity: 0.5; cursor: not-allowed; }

table {
  width: 100%;
  border-collapse: collapse;
}

th, td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

code, pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: #0b0d11;
  border-radius: 6px;
}

pre { padding: 12px; overflow: auto; }
code { padding: 1px 5px; }

.diff-added { color: var(--ok); }
.diff-removed { color: var(--danger); }

.toast-region {
  position: fixed;
  right: 16px;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.toast {
  background: var(--panel);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  padding: 10px 14px;
}

[hidden] { display: none !important; }
`

/** The stylesheet asset, digested once at module load. */
export const APP_CSS: Asset = buildAsset(APP_CSS_SOURCE, 'text/css; charset=utf-8')
