import { buildAsset, type Asset } from './app-css.js'

/**
 * The tab icon, inlined like the stylesheet and the script (M4.5 hardening
 * wave 3). It exists because of the manual M4 smoke: a browser probes
 * `/favicon.ico` unprompted, the route table had no entry for it, and
 * deny-by-default answered a 403 that showed up in the console of every page —
 * noise that trains an operator to ignore the console on a security surface.
 *
 * SVG rather than a binary `.ico`: it is a few bytes, it stays readable in the
 * repository, and it needs no build step. The mark is a journal page with a
 * check — the plane's two jobs, recording and approving.
 */
const FAVICON_SOURCE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="6" fill="#1f2933"/>
<path d="M9 8h11l4 4v12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z" fill="#f5f3ee"/>
<path d="M11 17.5l3.2 3.2L21 14" fill="none" stroke="#1f2933" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`

/** The favicon asset, digested once at module load. */
export const FAVICON: Asset = buildAsset(FAVICON_SOURCE, 'image/svg+xml')
