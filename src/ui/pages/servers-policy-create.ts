import { CREATED_POLICY_DOCUMENT } from '../../policy/edit/created-policy.js'
import type { PolicyView } from '../../policy/edit/policy-view.js'
import { html, type Html } from '../html.js'
import { csrfField } from './csrf-field.js'

/**
 * The Servers page's empty state when there is no policy (ADR-0009 O4,
 * amendment 2026-10-02): what mcpcut does now, the one button that changes
 * it, and — before the click — the file and the exact content it writes. A
 * native form: the answer is a page carrying the next step
 * (`handlers/servers-create-policy.ts`). Not on a loaded or invalid policy,
 * and not on a hosted install.
 */

export const CREATE_POLICY_ACTION = '/servers/create-policy'

export interface PolicyCreateOptions {
  readonly view: PolicyView | undefined
  readonly isOwner: boolean
  readonly isTenant: boolean
  readonly csrfToken: string
}

const LEAD = 'No policy yet — mcpcut only journals'

export function renderPolicyCreate(options: PolicyCreateOptions): Html {
  const view = options.view
  if (view?.status !== 'absent' || options.isTenant) return html``
  if (!options.isOwner) {
    return html`<p class="callout srv-policy-create">${LEAD}. An owner can create one on this page.</p>`
  }
  return html`<div class="callout srv-policy-create">
      <div class="srv-policy-create-body">
        <p><strong>${LEAD}:</strong> no call is held, blocked or asked about. Create one to turn on the buttons by each tool. It allows every call, so nothing changes until you choose: <em>client</em> asks you in Claude Code before the call, a rule holds it for approval or blocks it.</p>
        <form method="post" action="${CREATE_POLICY_ACTION}" class="inline">
          ${csrfField(options.csrfToken)}
          <button type="submit">Create policy</button>
        </form>
        <p class="faint small">Writes <code>${view.sourcePath}</code>: <code>${JSON.stringify(CREATED_POLICY_DOCUMENT)}</code></p>
      </div>
    </div>`
}
