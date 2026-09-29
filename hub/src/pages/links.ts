import { html, safeUrl, type Html } from '../../../src/ui/html.js'

/**
 * The few places a hub page sends a person next, outside the hub itself: the
 * project's issues, the feedback discussion, and the person's own console.
 * The hub stores no email (PRD `hosted-accounts`, HA10), so these links are
 * the only way a person reaches us, or we hear back from them.
 */

export const REPOSITORY_ISSUES_URL = 'https://github.com/RostislavMatov/mcpcut/issues'

/** "Did it work for you?" — where a person tells us so in one click. */
export const FEEDBACK_URL = 'https://github.com/RostislavMatov/mcpcut/discussions/1'

/** The tenant's console (`https://alice.mcpcut.com/`), shown as its host name. */
export function consoleLink(serveUrl: string): Html {
  const host = new URL(serveUrl).host
  return html`<a href="${safeUrl(`${serveUrl}/`)}">${host}</a>`
}
