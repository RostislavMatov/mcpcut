import { CSS_PAGE_DASHBOARD } from './page-dashboard.js'
import { CSS_PAGE_GROUPS } from './page-groups.js'
import { CSS_PAGE_JOURNAL } from './page-journal.js'
import { CSS_PAGE_LOGIN } from './page-login.js'
import { CSS_PAGE_MATRIX } from './page-matrix.js'
import { CSS_PAGE_SERVERS } from './page-servers.js'

/**
 * Page-specific layout, one module per page family, concatenated here in a
 * fixed order and appended after the shared components (`app-css.ts`). A page
 * module may lay out ITS OWN regions (grids, column widths, row templates) but
 * must not restyle shared components — if a page needs a variant of a shared
 * class, the variant belongs in `components.ts`.
 */
export const CSS_PAGES = [
  CSS_PAGE_LOGIN,
  CSS_PAGE_DASHBOARD,
  CSS_PAGE_SERVERS,
  CSS_PAGE_JOURNAL,
  CSS_PAGE_MATRIX,
  CSS_PAGE_GROUPS,
].join('\n')
