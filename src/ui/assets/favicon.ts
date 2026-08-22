import { buildAsset, type Asset } from './asset.js'

/**
 * The tab icon, inlined like the stylesheet and the script (M4.5 hardening
 * wave 3). It exists because of the manual M4 smoke: a browser probes
 * `/favicon.ico` unprompted, the route table had no entry for it, and
 * deny-by-default answered a 403 that showed up in the console of every page —
 * noise that trains an operator to ignore the console on a security surface.
 *
 * SVG rather than a binary `.ico`: it is a few bytes, it stays readable in the
 * repository, and it needs no build step. The mark follows the McpCut console
 * language (2026-08-22): a black tile with a white 2px rule and a pixel "M"
 * drawn on a 4px grid — monochrome, like everything else in the UI.
 */
const FAVICON_SOURCE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">
<rect width="32" height="32" rx="6" fill="#000000"/>
<rect x="2" y="2" width="28" height="28" rx="5" fill="none" stroke="#FFFFFF" stroke-width="2"/>
<path fill="#FFFFFF" d="M8 22V10h4l4 6 4-6h4v12h-4v-6l-4 6-4-6v6z"/>
</svg>
`

/** The favicon asset, digested once at module load. */
export const FAVICON: Asset = buildAsset(FAVICON_SOURCE, 'image/svg+xml')
