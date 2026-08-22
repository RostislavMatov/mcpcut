import { buildAsset, type Asset } from './asset.js'
import { CSS_BASE } from './css/base.js'
import { CSS_COMPONENTS } from './css/components.js'
import { CSS_FORMS } from './css/forms.js'
import { CSS_LAYOUT } from './css/layout.js'
import { CSS_PAGES } from './css/pages.js'

/**
 * The single stylesheet of the admin UI (`/assets/app.css`), concatenated at
 * module load from the CSS modules under `./css/` in a fixed order: tokens and
 * resets first, then the shell, then shared components and form controls, then
 * page-specific layout. Each module is one exported template string; none
 * contains `@import` or an external URL — the UI's CSP is `default-src
 * 'none'; style-src 'self'; font-src 'self'`, so anything off-origin would
 * simply be blocked (`tests/ui/html.test.ts` pins this).
 *
 * `buildAsset` / `Asset` are re-exported for the modules that historically
 * imported them from here.
 */
export { buildAsset, type Asset } from './asset.js'

const APP_CSS_SOURCE = [CSS_BASE, CSS_LAYOUT, CSS_COMPONENTS, CSS_FORMS, CSS_PAGES].join('\n')

/** The stylesheet asset, digested once at module load. */
export const APP_CSS: Asset = buildAsset(APP_CSS_SOURCE, 'text/css; charset=utf-8')
