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
 *     `data-payload` (optional JSON string sent as the request body). Without
 *     it, a <form> posts its own named fields as the JSON body (all but the
 *     `csrf_token` field, which rides in the header) — a form whose identity
 *     lives in hidden inputs (quarantine: `server`/`tool`) then sends the same
 *     thing over fetch as over a native submit.
 *   - after a 2xx the script re-fetches the live region the control sits in
 *     when that region carries `data-live-settle` (see below), and falls back
 *     to a full reload otherwise; `data-no-reload` suppresses both.
 *
 *  Live regions (SSE-driven refresh)
 *   - `<body data-events-url="/events">` names the SSE endpoint. The attribute
 *     is present only on authenticated pages; without it the script opens no
 *     stream at all (the login page has no live channel).
 *   - a container with `data-live-region="approval-pending approval-resolved"`
 *     lists the SSE topics that should refresh it; the script re-fetches
 *     `data-live-src` (default: current URL) and swaps the container's
 *     innerHTML from the matching `data-live-region` node in the response.
 *   - `data-live-text="<key>"` on a node OUTSIDE the region (a count in a
 *     panel head, the nav meta) makes its text follow the same-keyed node of
 *     the fetched document on every swap.
 *   - `data-live-settle` on a region declares the page fully live around it:
 *     an action inside settles by re-fetching the region instead of reloading.
 *     Opt-in on purpose — the dashboard's tiles, decisions and servers strip
 *     sit outside its queue region and would go stale without a reload.
 *   - `data-pending-count` on any element is kept in sync and mirrored into
 *     the document title so a background tab shows a badge. The optional
 *     `data-pending-total` on the SAME element overrides it when it is larger:
 *     queue reads are bounded, and a badge built from the truncated count
 *     would under-report the backlog the page body admits to.
 *
 *  Server status dots (M5.5 p.1, O7)
 *   - the Servers page renders each card's dot with `data-server="<name>"`
 *     (pages/servers-status.ts); a `server-status-changed` SSE event carries
 *     JSON `{server, status, probedVia?, probedAt?, latencyMs?, error?}` and
 *     `applyServerStatus` swaps the dot's class and `title` in place.
 *
 *  Signed out mid-session
 *   - every scripted request carries `x-requested-with: fetch`, which a dead
 *     session answers with 401 instead of the redirect a navigation gets.
 *   - a 401 — or, belt and braces, a response that followed a redirect to
 *     `/login` — means the session cookie is dead: the script replaces the
 *     current location with `/login` rather than toasting a status code.
 *
 *  Fallback
 *   - if SSE errors, the script polls `data-live-src` (or the page) every
 *     `data-poll-ms` (default 5000) until SSE recovers. Status-dot events have
 *     no polling arm: a missed one is corrected by the next full page load.
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

  // --- Signed out mid-session -----------------------------------------------
  // The server answers a request that carries a DEAD session cookie by clearing
  // it and pointing at /login: 401 for a script's fetch, a redirect for a
  // navigation. Either way the page in front of the operator is a corpse — the
  // buttons on it can only fail — so it goes to the sign-in screen instead of
  // toasting a status code nobody can act on.
  function isLoginUrl(url) {
    try {
      return new URL(url, window.location.href).pathname === "/login";
    } catch (err) {
      return false;
    }
  }

  // Checked BEFORE res.ok: fetch follows a redirect transparently, so a
  // navigation-shaped GET that landed on /login arrives here as a 200.
  function isSignedOut(res) {
    return res.status === 401 || (res.redirected === true && isLoginUrl(res.url));
  }

  function goToLogin() {
    if (window.location.pathname === "/login") return;
    window.location.replace("/login");
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

  // The named fields of a scripted <form>, as the JSON body runAction posts
  // when no data-payload is set; null for a non-form or a form with no field
  // beyond csrf_token, so such actions keep posting no body at all.
  function formPayload(el) {
    var fields = el.elements;
    if (!fields) return null;
    var out = {};
    var any = false;
    for (var i = 0; i < fields.length; i++) {
      var name = fields[i].name;
      if (!name || name === "csrf_token") continue;
      out[name] = fields[i].value;
      any = true;
    }
    return any ? JSON.stringify(out) : null;
  }

  // "disabled" on a <form> disables nothing, and the action forms carry
  // data-action on the form itself: toggle the buttons inside as well.
  function setBusy(el, busy) {
    el.disabled = busy;
    var buttons = el.querySelectorAll ? el.querySelectorAll("button, input[type=submit]") : [];
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = busy;
  }

  // After a 2xx: re-fetch the live region the control sits in when that
  // region opted in with data-live-settle (the quarantine list — everything
  // the action changes is inside it or marked data-live-text), so the page
  // never flashes; reload otherwise. A successful swap replaces the control;
  // a failed re-fetch releases it instead of leaving it stuck.
  function settleAction(el) {
    if (el.hasAttribute("data-no-reload")) return;
    var region = el.closest("[data-live-region][data-live-settle]");
    if (!region) { window.location.reload(); return; }
    return refreshRegion(region).then(function () { setBusy(el, false); });
  }

  // The refusal's own words, when the server sent a JSON body with a
  // "message" (a 409 "policy changed on disk" must not read as a bare code).
  function failureMessage(res) {
    return res.json()
      .then(function (body) { return body && typeof body.message === "string" ? body.message : ""; })
      .catch(function () { return ""; });
  }

  // The refusal in the operator's words. 403 is the one status a bare code
  // cannot explain: a dead session is now a 401 of its own, so what is left is
  // an insufficient role or a page whose CSRF token went stale — name both,
  // because the operator's next move differs (ask an owner vs. reload).
  function refusalText(res, message) {
    if (message) return "Action failed (" + res.status + "): " + message;
    if (res.status === 403) return "Not allowed: your role does not permit this, or the page went stale \u2014 reload and retry";
    return "Action failed (" + res.status + ")";
  }

  function runAction(el) {
    var url = el.getAttribute("data-action");
    var method = (el.getAttribute("data-method") || "POST").toUpperCase();
    var payload = el.getAttribute("data-payload");
    if (payload === null) payload = formPayload(el);
    setBusy(el, true);
    fetch(url, {
      method: method,
      credentials: "same-origin",
      headers: {
        "x-csrf-token": csrfToken(),
        "content-type": "application/json",
        // "a script is asking": a dead session answers this with 401 rather
        // than a redirect fetch would follow into a misleading 200.
        "x-requested-with": "fetch",
      },
      body: payload || undefined,
    })
      .then(function (res) {
        if (isSignedOut(res)) {
          goToLogin();
        } else if (res.ok) {
          settleAction(el);
        } else {
          return failureMessage(res).then(function (message) {
            announce(refusalText(res, message));
            setBusy(el, false);
          });
        }
      })
      .catch(function () {
        announce("Network error");
        setBusy(el, false);
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

  // Re-fetches of one region may overlap (the operator's own settle and the
  // watcher's event within the same second); each carries a generation and a
  // response is dropped when a later re-fetch has since superseded it, so an
  // older response never overwrites newer cards.
  function refreshRegion(region) {
    var src = region.getAttribute("data-live-src") || window.location.href;
    var generation = String((parseInt(region.getAttribute("data-live-generation") || "0", 10) || 0) + 1);
    region.setAttribute("data-live-generation", generation);
    return fetch(src, { credentials: "same-origin", headers: { "x-requested-with": "fetch" } })
      .then(function (res) {
        // An idle tab whose session died: SSE drops, the poll arm keeps
        // re-fetching, and every answer is the login page. Without this the
        // operator watches a frozen queue that never says why.
        if (isSignedOut(res)) { goToLogin(); return Promise.reject(res.status); }
        return res.ok ? res.text() : Promise.reject(res.status);
      })
      .then(function (htmlText) {
        if (region.getAttribute("data-live-generation") === generation) swapRegion(region, htmlText);
      })
      .catch(function () { /* keep the stale view; a later event retries */ });
  }

  function swapRegion(region, htmlText) {
    var doc = new DOMParser().parseFromString(htmlText, "text/html");
    var key = region.getAttribute("data-live-region");
    var fresh = doc.querySelector('[data-live-region="' + cssEscape(key) + '"]');
    if (fresh) {
      region.innerHTML = fresh.innerHTML;
      syncPendingBadge(doc);
      syncLiveText(doc);
    }
  }
  // Text nodes OUTSIDE a live region that still describe it (the quarantine
  // "N held" in the panel head and the nav meta): copied from the fresh doc.
  function syncLiveText(scope) {
    var nodes = document.querySelectorAll("[data-live-text]");
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute("data-live-text");
      var fresh = scope.querySelector('[data-live-text="' + cssEscape(key) + '"]');
      if (fresh) nodes[i].textContent = fresh.textContent;
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

  // --- Server status dots (M5.5 p.1, O7) ------------------------------------
  // A "server-status-changed" SSE event carries JSON
  // {server, status, probedVia?, probedAt?, latencyMs?, error?}; the handler
  // finds the dot rendered by pages/servers-status.ts via its data-server
  // hook and swaps class + tooltip in place — no reload. Class strings and
  // tooltip wording mirror statusDotClassOf/statusTitleOf on the server so a
  // live update reads like a fresh render. An SSE result knows nothing of the
  // passive traffic signal, so it never sets the white-blink state; the next
  // full render restores it. "title" is a text property — never parsed as
  // HTML — so a hostile error cause stays inert.
  function serverStatusDotClass(status) {
    if (status === "alive") return "dot srv-dot";
    if (status === "probing") return "dot srv-dot dot-off dot-blink";
    if (status === "never-checked") return "dot srv-dot dot-hollow";
    return "dot srv-dot dot-off";
  }

  function serverStatusTitle(detail) {
    if (detail.status === "never-checked") return "never checked";
    if (detail.status === "probing") {
      return detail.probeStartedAt ? "probing\\u2026 \\u00b7 started " + detail.probeStartedAt : "probing\\u2026";
    }
    var parts = [String(detail.status)];
    parts.push(detail.probedVia ? "probe (" + detail.probedVia + ")" : "probe");
    if (detail.probedAt) parts.push(String(detail.probedAt));
    if (typeof detail.latencyMs === "number") parts.push(Math.round(detail.latencyMs) + "ms");
    if (detail.error) parts.push(String(detail.error));
    return parts.join(" \\u00b7 ");
  }

  function applyServerStatus(detail) {
    if (!detail || typeof detail.server !== "string" || typeof detail.status !== "string") return;
    var dot = document.querySelector('.srv-dot[data-server="' + cssEscape(detail.server) + '"]');
    if (!dot) return;
    dot.className = serverStatusDotClass(detail.status);
    dot.title = serverStatusTitle(detail);
  }

  function onServerStatusEvent(data) {
    var detail = null;
    try { detail = JSON.parse(data); } catch (err) { return; }
    applyServerStatus(detail);
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
    source.addEventListener("server-status-changed", function (event) { onServerStatusEvent(event.data); });
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
    return String(text || "").toLowerCase().replace(/\\s+/g, " ").trim();
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
