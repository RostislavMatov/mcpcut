import { CSS_PAGE_LOGIN } from './page-login.js'

/**
 * Page-specific layout, one module per page family, concatenated here in a
 * fixed order and appended after the shared components (`app-css.ts`). A page
 * module may lay out ITS OWN regions (grids, column widths, row templates) but
 * must not restyle shared components — if a page needs a variant of a shared
 * class, the variant belongs in `components.ts`.
 */
export const CSS_PAGES = [CSS_PAGE_LOGIN].join('\n')
