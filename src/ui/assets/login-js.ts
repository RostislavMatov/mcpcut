import { buildAsset, type Asset } from './asset.js'
import { LOGIN_JS_DECOR_SOURCE } from './login-js-decor.js'
import { LOGIN_JS_SIGNIN_SOURCE } from './login-js-signin.js'

/**
 * The `/login` page script (`/assets/login.js`) — the Auth screen of the
 * McpCut design, ported from the Claude Design prototype (2026-08-22):
 *
 *  - the decorative layer: pixel blocks fly in on the left, fill with a
 *    striped white wipe, draw a right-angled route to the "console" box on
 *    the right with a glowing dot travelling along it, the box "types" a
 *    journal record and rolls it out into a growing stack; scrolling the page
 *    fades the card and expands the stack into wide journal rows;
 *  - the sign-in choreography: on submit the form's chrome fades, the token
 *    field is wiped white and "sent" down a route into the console box, a
 *    white sheet floods the viewport, and only THEN the form is submitted for
 *    real (`form.submit()`, which skips the submit event) — a failed login
 *    re-renders the page with its error exactly as before;
 *  - two small controls: Show/Hide on the token field and the remember toggle.
 *
 * Constraints honoured (CSP `script-src 'self'; style-src 'self'`): no inline
 * handlers, no `<style>`, no `style=""` attributes in markup. Geometry that
 * is only known at runtime (line lengths, dot positions) is set through the
 * CSSOM (`el.style.prop = …`), which CSP does not govern; everything static
 * (keyframes, colours, transitions) lives in `css/page-login.ts` as classes.
 *
 * Everything degrades: without JS the page is the plain form; under
 * `prefers-reduced-motion: reduce` the script only wires the two controls and
 * leaves the decor layer hidden; the decor never receives or renders any
 * server data — the "records" it types are synthetic by design (it is art,
 * not the journal).
 *
 * Split across two modules (decor / sign-in) to respect the file-size rule;
 * concatenated here into one asset.
 */
const LOGIN_JS_SOURCE = `"use strict";
(function () {
  if (!document.body.classList.contains("page-login")) return;
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var form = document.querySelector("form[action='/login']");
  var tokenInput = form ? form.querySelector("input[name='token']") : null;
  var layer = document.querySelector("[data-decor]");

  // --- Show / hide the token ------------------------------------------------
  var reveal = document.querySelector("[data-reveal]");
  if (reveal && tokenInput) {
    reveal.addEventListener("click", function () {
      var hidden = tokenInput.getAttribute("type") === "password";
      tokenInput.setAttribute("type", hidden ? "text" : "password");
      reveal.textContent = hidden ? "Hide" : "Show";
      reveal.setAttribute("aria-pressed", hidden ? "true" : "false");
    });
  }

  // --- Remember toggle (visual state only; the session lifetime is fixed server-side) ---
  var remember = document.querySelector("[data-remember]");
  if (remember) {
    var sync = function () { remember.parentElement.classList.toggle("is-on", remember.checked); };
    remember.addEventListener("change", sync);
    sync();
  }

  if (reduced || !layer || !form || !tokenInput) return;
  var timers = [];
  var T = function (fn, ms) { var id = setTimeout(fn, ms); timers.push(id); return id; };
  var rnd = function (n) { return Math.round(Math.random() * n); };
  var px = function (v) { return v + "px"; };
  var state = { signing: false, expand: 0, wideNow: 0, srcFade: 0, targetBusy: false, doneBatch: [], tabs: [], tabsWrap: null, stats: null, targetHome: null, wrapTop: 0, flooded: false };
${LOGIN_JS_DECOR_SOURCE}
${LOGIN_JS_SIGNIN_SOURCE}
  boot();
})();
`

/** The login page script asset, digested once at module load. */
export const LOGIN_JS: Asset = buildAsset(LOGIN_JS_SOURCE, 'text/javascript; charset=utf-8')
