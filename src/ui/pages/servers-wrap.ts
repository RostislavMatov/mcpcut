import { RESERVED_SERVER_NAME_PREFIX } from '../../registry/constants.js'
import { html, join, type Html } from '../html.js'
import { renderToolsModal, renderToolsRow, type ServerToolsByName, type ToolsPanelContext } from './servers-tools.js'

/**
 * "On this machine (wrap)": servers that run under `mcpcut wrap` here. They
 * are not in the registry, so they get no card — but the inventory knows their
 * tools, and their rules (admin and client) are keyed by name like any other
 * server's. Each gets the same tools panel; the page renders the modals as
 * siblings of the section, as it does for the cards.
 */

export interface WrapSectionOptions {
  readonly names: readonly string[]
  readonly tools: ServerToolsByName | undefined
  /** The panel context of one wrap server (names, CSRF, rule controls, wrap-only client choices). */
  readonly contextOf: (serverName: string) => ToolsPanelContext
}

const WRAP_HEADING = 'On this machine (wrap)'

/** The section, or nothing when no wrap server is known. */
export function renderWrapSection(options: WrapSectionOptions): Html {
  if (options.names.length === 0) return html``
  const hasAutoName = options.names.some((name) => name.startsWith(RESERVED_SERVER_NAME_PREFIX))
  const autoHint = hasAutoName
    ? html`<p class="faint small">Names that start with <code>auto:</code> are generated; run <code>mcpcut wrap --server &lt;name&gt; -- &lt;command&gt;</code> for a readable name.</p>`
    : html``
  const rows = options.names.map(
    (name) => html`<div class="srv-wrap-row"><span class="name pixel ellipsis">${name}</span>${renderToolsRow(name, options.tools?.get(name), false)}</div>`,
  )
  return html`<section class="srv-wrap" aria-label="${WRAP_HEADING}">
    <h2 class="pixel upper srv-wrap-hd">${WRAP_HEADING}</h2>
    <p class="muted small">Run here with <code>mcpcut wrap</code>, not in the registry. Rules apply by name.</p>
    ${autoHint}
    <div class="rows">${join(rows)}</div>
  </section>
  ${join(options.names.map((name) => renderToolsModal(options.tools?.get(name), options.contextOf(name))))}`
}
