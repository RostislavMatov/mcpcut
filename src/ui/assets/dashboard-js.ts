import { buildAsset, type Asset } from './asset.js'

/**
 * The dashboard enhancement (`/assets/dashboard.js`): clicking a journal row
 * swaps the selection highlight and rewrites the "Call detail" card in place,
 * instead of the full `?sel=` navigation — which remains the no-JS path (the
 * rows stay real links, and modified clicks / non-primary buttons are left to
 * the browser). Every value written into the card comes from the row's own
 * data attributes, which the SERVER rendered and escaped; the script only
 * moves text between nodes (`textContent`) and copies the server-built
 * session href (accepted only when it still starts with `/journal?`), so no
 * markup is ever constructed client-side. The URL stays deep-linkable via
 * `history.replaceState` with the row's href.
 */
const DASHBOARD_JS_SOURCE = `(function () {
  "use strict";
  var DETAIL_KEYS = ["server", "tool", "caller", "started", "duration", "status", "meta"];

  function selectRow(detail, rowsHost, row) {
    var prev = rowsHost.querySelector("a.dash-row.is-sel");
    if (prev && prev !== row) prev.classList.remove("is-sel");
    row.classList.add("is-sel");
    var id = detail.querySelector("[data-d='id']");
    if (id) id.textContent = row.getAttribute("data-detail-id") || "\\u2014";
    for (var i = 0; i < DETAIL_KEYS.length; i++) {
      var el = detail.querySelector("[data-d='" + DETAIL_KEYS[i] + "']");
      if (!el) continue;
      var value = row.getAttribute("data-" + DETAIL_KEYS[i]) || "\\u2014";
      el.textContent = value;
      if (el.hasAttribute("title")) el.setAttribute("title", value);
    }
    var open = detail.querySelector("a.detail-open");
    var href = row.getAttribute("data-session-href");
    if (open && href && href.indexOf("/journal?") === 0) open.setAttribute("href", href);
    if (window.history && history.replaceState) history.replaceState(null, "", row.getAttribute("href"));
  }

  function rowOf(node, rowsHost) {
    while (node && node !== rowsHost) {
      if (node.tagName === "A" && node.classList.contains("dash-row")) return node;
      node = node.parentNode;
    }
    return null;
  }

  function boot() {
    var detail = document.querySelector(".dash-detail");
    var rowsHost = document.querySelector(".dash-rows");
    if (!detail || !rowsHost || !detail.querySelector("[data-d='id']")) return;
    rowsHost.addEventListener("click", function (event) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var row = rowOf(event.target, rowsHost);
      if (!row || !row.hasAttribute("data-detail-id")) return;
      event.preventDefault();
      selectRow(detail, rowsHost, row);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
`

/** The dashboard script asset, digested once at module load. */
export const DASHBOARD_JS: Asset = buildAsset(DASHBOARD_JS_SOURCE, 'text/javascript; charset=utf-8')
