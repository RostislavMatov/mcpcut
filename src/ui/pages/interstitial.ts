import { html, safeUrl, type Html } from '../html.js'

/**
 * The shared confirmation interstitial: one strong panel carrying a heading,
 * a callout that states the consequence, the details being confirmed, the
 * confirm form and a way back.
 *
 * It was the servers page's private `renderInterstitial`; `/groups` (M5.5 п.2)
 * confirms a removal the same way, and a second copy of a page whose entire
 * job is "make the consequence unmissable" is exactly the copy that drifts.
 * The markup is unchanged — `panelClass` and the cancel link are the only
 * parameters the move added.
 *
 * `form` may be an empty fragment: a REFUSAL panel (e.g. "this group still has
 * members") is the same layout with no way forward, only a way back.
 */
export interface InterstitialOptions {
  readonly heading: Html
  readonly warning: Html
  readonly details: Html
  /** The confirm form, or `html``` for a refusal that offers no confirmation. */
  readonly form: Html
  /** Page-family class on the panel, e.g. `srv-confirm`. */
  readonly panelClass: string
  /** Where "cancel" goes — the page the interstitial interrupted. */
  readonly cancelHref: string
  /** Cancel link text; defaults to `Cancel`. */
  readonly cancelLabel?: string
}

export function renderInterstitial(options: InterstitialOptions): Html {
  return html`<section class="panel panel-strong ${options.panelClass}">
    <div class="panel-hd"><h1>${options.heading}</h1></div>
    <div class="panel-bd">
      <div class="callout">${options.warning}</div>
      ${options.details}
      ${options.form}
      <p><a href="${safeUrl(options.cancelHref)}">${options.cancelLabel ?? 'Cancel'}</a></p>
    </div>
  </section>`
}
