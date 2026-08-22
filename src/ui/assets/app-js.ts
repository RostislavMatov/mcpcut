import { buildAsset, type Asset } from './asset.js'

/**
 * Inlined client script for the admin UI. Vanilla, no framework, no external
 * origin (the UI's CSP is `script-src 'self'` and forbids inline handlers and
 * CDNs). Served as a same-origin file referenced by `layout.ts`; never inline.
 *
 * This is the Wave-2 scaffold: it wires the two mechanisms every Wave-3 page
 * needs — a live SSE feed and CSRF-guarded fetch actions — and leaves clear
 * extension points. It performs no page-specific logic itself.
 *
 * DOM-hook contract for Wave 3 (pages emit these; this script consumes them):
 *
 *  CSRF
 *   - `<meta name="csrf-token" content="…">` (rendered by layout): every
 *     mutating fetch reads it and sends it as the `x-csrf-token` header. Pages
 *     that use real <form> POSTs must additionally include it as a hidden
 *     field named `csrf_token`.
 *
 *  Actions (mutations without a full page nav)
 *   - any element with `data-action="/path"` triggers a fetch on click.
 *   - `data-method` (default `POST`), `data-confirm` (optional confirm text),
 *     `data-payload` (optional JSON string sent as the request body).
 *   - after a 2xx the script reloads, unless `data-no-reload` is present.
 *
 *  Live regions (SSE-driven refresh)
 *   - `<body data-events-url="/events">` names the SSE endpoint. The attribute
 *     is present only on authenticated pages; without it the script opens no
 *     stream at all (the login page has no live channel).
 *   - a container with `data-live-region="approval-pending approval-resolved"`
 *     lists the SSE topics that should refresh it; the script re-fetches
 *     `data-live-src` (default: current URL) and swaps the container's
 *     innerHTML from the matching `data-live-region` node in the response.
 *   - `data-pending-count` on any element is kept in sync and mirrored into
 *     the document title so a background tab shows a badge. The optional
 *     `data-pending-total` on the SAME element overrides it when it is larger:
 *     queue reads are bounded, and a badge built from the truncated count
 *     would under-report the backlog the page body admits to.
 *
 *  Fallback
 *   - if SSE errors, the script polls `data-live-src` (or the page) every
 *     `data-poll-ms` (default 5000) until SSE recovers.
 *
 *  Disclosure helpers (McpCut console; every one degrades to plain HTML)
 *   - `data-open-details="<id>"` on a link opens the `<details id>` and
 *     scrolls to it (without JS the link is a plain `#id` anchor to the same
 *     element, whose `<summary>` is visible and clickable).
 *   - `data-close-details` on a button inside a `<details>` closes it.
 *   - `form.search[data-client-filter]`: typing narrows `[data-filter-item]`
 *     nodes by their text (without JS the form is an ordinary GET).
 */
const APP_JS_SOURCE = `"use strict";
(function () {
  var DEFAULT_POLL_MS = 5000;
  var LIVE_TOPICS = ["approval-pending", "approval-resolved", "quarantine-changed"];

  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute("content") || "" : "";
  }

  // --- CSRF-guarded actions -------------------------------------------------
  function onActionClick(event) {
    var el = event.target.closest("[data-action]");
    if (!el) return;
    event.preventDefault();
    var confirmText = el.getAttribute("data-confirm");
    if (confirmText && !window.confirm(confirmText)) return;
    runAction(el);
  }

  function runAction(el) {
    var url = el.getAttribute("data-action");
    var method = (el.getAttribute("data-method") || "POST").toUpperCase();
    var payload = el.getAttribute("data-payload");
    el.setAttribute("disabled", "disabled");
    fetch(url, {
      method: method,
      credentials: "same-origin",
      headers: {
        "x-csrf-token": csrfToken(),
        "content-type": "application/json",
      },
      body: payload || undefined,
    })
      .then(function (res) {
        if (res.ok) {
          if (!el.hasAttribute("data-no-reload")) window.location.reload();
        } else {
          announce("Action failed (" + res.status + ")");
          el.removeAttribute("disabled");
        }
      })
      .catch(function () {
        announce("Network error");
        el.removeAttribute("disabled");
      });
  }

  // --- Live regions via SSE -------------------------------------------------
  function liveRegionsFor(topic) {
    var out = [];
    var nodes = document.querySelectorAll("[data-live-region]");
    for (var i = 0; i < nodes.length; i++) {
      var topics = (nodes[i].getAttribute("data-live-region") || "").split(/\\s+/);
      if (topics.indexOf(topic) !== -1) out.push(nodes[i]);
    }
    return out;
  }

  function refreshRegion(region) {
    var src = region.getAttribute("data-live-src") || window.location.href;
    fetch(src, { credentials: "same-origin", headers: { "x-requested-with": "fetch" } })
      .then(function (res) { return res.ok ? res.text() : Promise.reject(res.status); })
      .then(function (htmlText) { swapRegion(region, htmlText); })
      .catch(function () { /* keep the stale view; a later event retries */ });
  }

  function swapRegion(region, htmlText) {
    var doc = new DOMParser().parseFromString(htmlText, "text/html");
    var key = region.getAttribute("data-live-region");
    var fresh = doc.querySelector('[data-live-region="' + cssEscape(key) + '"]');
    if (fresh) {
      region.innerHTML = fresh.innerHTML;
      syncPendingBadge(doc);
    }
  }

  function cssEscape(value) {
    return String(value).replace(/["\\\\]/g, "\\\\$&");
  }

  function handleEvent(topic) {
    var regions = liveRegionsFor(topic);
    for (var i = 0; i < regions.length; i++) refreshRegion(regions[i]);
  }

  // --- Pending badge in the tab title --------------------------------------
  function syncPendingBadge(scope) {
    var node = (scope || document).querySelector("[data-pending-count]");
    if (!node) return;
    var count = parseInt(node.getAttribute("data-pending-count") || "0", 10) || 0;
    // A bounded read renders fewer cards than the queue holds and says so in
    // the page body; the tab badge must report the QUEUE, not the page, or a
    // glance at the tab reads a truncated backlog as drained. NaN (attribute
    // absent, the untruncated case) fails this compare and leaves count alone.
    var total = parseInt(node.getAttribute("data-pending-total") || "", 10);
    if (total > count) count = total;
    var base = document.title.replace(/^\\(\\d+\\)\\s*/, "");
    document.title = count > 0 ? "(" + count + ") " + base : base;
  }

  // --- Toast / announce -----------------------------------------------------
  function announce(message) {
    var region = document.querySelector(".toast-region");
    if (!region) return;
    var toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    region.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 6000);
  }

  // --- Transport: SSE with polling fallback --------------------------------
  var pollTimer = null;

  function startPolling(url) {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      LIVE_TOPICS.forEach(handleEvent);
    }, pollMs());
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function pollMs() {
    var raw = document.body.getAttribute("data-poll-ms");
    var n = raw ? parseInt(raw, 10) : DEFAULT_POLL_MS;
    return n > 0 ? n : DEFAULT_POLL_MS;
  }

  function connect() {
    var url = document.body.getAttribute("data-events-url");
    // No attribute means this page has no live channel (the login page is the
    // only one): opening a stream there could only ever be refused, and the
    // 403 landed in the console of every visitor.
    if (!url) { return; }
    if (typeof window.EventSource === "undefined") { startPolling(url); return; }
    var source = new EventSource(url, { withCredentials: true });
    source.onopen = function () { stopPolling(); };
    source.onerror = function () { startPolling(url); };
    LIVE_TOPICS.forEach(function (topic) {
      source.addEventListener(topic, function () { handleEvent(topic); });
    });
  }

  // --- Disclosure helpers ---------------------------------------------------
  function onDetailsClick(event) {
    var opener = event.target.closest("[data-open-details]");
    if (opener) {
      var target = document.getElementById(opener.getAttribute("data-open-details"));
      if (target && typeof target.open === "boolean") {
        event.preventDefault();
        target.open = true;
        target.scrollIntoView({ block: "start" });
        var focusable = target.querySelector("input, select, textarea");
        if (focusable) focusable.focus();
      }
      return;
    }
    var closer = event.target.closest("[data-close-details]");
    if (closer) {
      var details = closer.closest("details");
      if (details) { event.preventDefault(); details.open = false; }
    }
  }

  function normalize(text) {
    return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function applyClientFilter(input) {
    var needle = normalize(input.value);
    var items = document.querySelectorAll("[data-filter-item]");
    var shown = 0;
    for (var i = 0; i < items.length; i++) {
      var hay = normalize(items[i].getAttribute("data-filter-text") || items[i].textContent);
      var hit = !needle || hay.indexOf(needle) !== -1;
      items[i].hidden = !hit;
      if (hit) shown++;
    }
    var empty = document.querySelector("[data-filter-empty]");
    if (empty) empty.hidden = shown > 0 || items.length === 0;
  }

  function wireClientFilter() {
    var form = document.querySelector("form.search[data-client-filter]");
    if (!form) return;
    var input = form.querySelector("input");
    if (!input) return;
    form.addEventListener("submit", function (event) { event.preventDefault(); applyClientFilter(input); });
    input.addEventListener("input", function () { applyClientFilter(input); });
    if (input.value) applyClientFilter(input);
  }

  function init() {
    document.addEventListener("click", onActionClick);
    document.addEventListener("click", onDetailsClick);
    wireClientFilter();
    syncPendingBadge(document);
    connect();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
`

/** The client script asset, digested once at module load. */
export const APP_JS: Asset = buildAsset(APP_JS_SOURCE, 'text/javascript; charset=utf-8')
