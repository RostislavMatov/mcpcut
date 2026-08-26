import { POLICY_HASH_PREVIEW_CHARS } from '../../policy/constants.js'
import type { PolicyView } from '../../policy/edit/policy-view.js'
import { describePolicyReaders } from '../../policy/edit/write-target.js'
import { html, join, type Html } from '../html.js'
import type { ToolRuleControls } from './servers-tool-rule.js'

/**
 * The page-level projection of `PolicyView` (ADR-0009, the ADR-0005 sources
 * panel): the state of the rule controls for this viewer, the tools-panel
 * note, the sources line above the card grid and the page-top banner for a
 * policy that cannot be edited (invalid on disk — O3).
 *
 * Correction 2026-08-26: the card edits the file this process loaded, so who
 * ELSE reads that file is a statement under the sources line, not a reason to
 * disable the controls. Editing is refused only where a write cannot be
 * attributed or validated: no policy at all (O4) and an unparseable file.
 */

/** Characters of the policy hash shown in the sources line. */

const NO_POLICY_NOTE = 'no policy — enforcement off'
const INVALID_POLICY_REASON = 'policy file on disk is invalid — fix it by hand'

/** How the rule controls render: hidden for non-owners / no policy port, else enabled or disabled with a reason. */
export function ruleControlsOf(view: PolicyView | undefined, isOwner: boolean): ToolRuleControls | undefined {
  if (view === undefined) return undefined
  if (!isOwner) return { mode: 'hidden' }
  if (view.status === 'loaded') return { mode: 'enabled', expectedHash: view.hash }
  if (view.status === 'absent') return { mode: 'disabled', reason: NO_POLICY_NOTE }
  return { mode: 'disabled', reason: INVALID_POLICY_REASON }
}

/** The one line above the tools when there is nothing to enforce (O4). */
export function toolsNoteOf(view: PolicyView | undefined): string | undefined {
  return view?.status === 'absent' ? NO_POLICY_NOTE : undefined
}

/** The page-top banner: only when the policy cannot be edited from here. */
export function renderPolicyBanner(view: PolicyView | undefined): Html {
  if (view === undefined || view.status !== 'error') return html``
  const errors = join(view.errors.map((error) => html`<li><code>${error}</code></li>`))
  return html`<div class="callout srv-policy-banner" role="alert">
      <p>policy file on disk is invalid — running proxies keep their last valid version; rule editing is off until it is fixed by hand:</p>
      <ul class="srv-policy-errors">${errors}</ul>
    </div>`
}

/**
 * Key of the live-text node carrying the policy hash. The sources line sits
 * OUTSIDE every card's settle region, so without this a rule change would
 * leave a stale digest on screen next to freshly-changed rules — and that
 * digest is what an operator compares against the journal.
 */
const POLICY_HASH_LIVE_KEY = 'policy-hash'

/** «policy · <path> · <hash8>» and, under it, which entry points read that file. */
export function renderPolicySources(view: PolicyView | undefined): Html {
  if (view === undefined) return html``
  const state =
    view.status === 'loaded'
      ? html`<span class="num" data-live-text="${POLICY_HASH_LIVE_KEY}">${view.hash.slice(0, POLICY_HASH_PREVIEW_CHARS)}</span>`
      : view.status === 'absent'
        ? html`<span data-live-text="${POLICY_HASH_LIVE_KEY}">absent — enforcement off</span>`
        : html`<span class="pill pill-alert" data-live-text="${POLICY_HASH_LIVE_KEY}">invalid</span>`
  return html`<div class="srv-policy-sources">
    <div class="srv-policy-src dim small">policy · <code>${view.sourcePath}</code> · ${state}</div>
    <div class="srv-policy-src faint small">${describePolicyReaders(view.readers)}</div>
  </div>`
}
