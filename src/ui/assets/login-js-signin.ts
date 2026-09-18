/**
 * Sign-in half of `/assets/login.js` (see `login-js.ts`). On submit the form
 * chrome fades, the token field is wiped white and "sent" down a route into
 * the console box, a white sheet floods the viewport — and then the form is
 * submitted for real. The token VALUE is never touched (the prototype blanked
 * it; we must post it), only its colour.
 *
 * Shares with the decor half: `layer`, `target`, `card`, `footer`, `form`,
 * `tokenInput`, `state`, `timers`, `T`, `px`, `el`, `reflow`, `raf2`,
 * `makeFill`, `makeDot`, `seg`, `removeAll`, `bootDecor`.
 *
 * HOW LONG IT TAKES. The prototype's choreography runs for
 * `DESIGN_TIMELINE_MS` before the POST leaves the browser. That is a fine
 * length for a design showcase and the wrong length for a control plane an
 * operator signs into several times a day — the user-journey smoke measured
 * 5.5 s on every single sign-in, error or not (2026-09-18, UX-2). So the whole
 * timeline is PLAYED FASTER rather than cut up: every duration in this module,
 * delays and CSS transitions alike, goes through `D()`, which scales it into
 * `SIGN_IN_BUDGET_MS`. Under `prefers-reduced-motion: reduce` none of it runs
 * at all — `login-js.ts` returns before `boot()`, so the browser submits the
 * plain form natively, exactly as it does with no JavaScript.
 */

/**
 * The prototype's own end-to-end timeline: the sum of the delays on the path
 * from the submit event to `form.submit()` (520 + 900 + 740 + 1460 + 900 +
 * 1000). Written down because the scale below is meaningless without it.
 */
const DESIGN_TIMELINE_MS = 5520

/** What a sign-in may spend on choreography before the real POST. */
export const SIGN_IN_BUDGET_MS = 1000

/** Every duration in the choreography is multiplied by this. */
const SIGN_IN_SCALE = SIGN_IN_BUDGET_MS / DESIGN_TIMELINE_MS

/**
 * What the scaled critical path actually costs, for the test that pins it.
 * Derived, not typed in: a change to either constant above moves this with it.
 */
export const SIGN_IN_TIMELINE_MS = Math.round(DESIGN_TIMELINE_MS * SIGN_IN_SCALE)

export const LOGIN_JS_SIGNIN_SOURCE = `
  // Every duration of the sign-in choreography passes through here: the
  // prototype's number in, the scaled one out (see the module comment).
  var D = function (ms) { return Math.round(ms * ${String(SIGN_IN_SCALE)}); };

  function fadeOut(node, ms) {
    if (!node) return;
    node.style.transition = "opacity " + ms + "ms linear, transform " + ms + "ms cubic-bezier(.4,0,.6,1)";
    node.style.opacity = "0";
    node.style.pointerEvents = "none";
  }

  function runSignIn() {
    if (state.signing) return;
    state.signing = true;
    var keepWrap = tokenInput.closest("label") || tokenInput.parentElement;
    Array.prototype.forEach.call(form.children, function (ch) {
      if (ch === keepWrap) return;
      if (ch.tagName === "INPUT" && ch.type === "hidden") return;
      ch.style.transition = "opacity " + D(420) + "ms linear, transform " + D(420) + "ms cubic-bezier(.4,0,.6,1)";
      ch.style.opacity = "0";
      ch.style.transform = "translateY(-6px)";
      ch.style.pointerEvents = "none";
    });
    var lab = keepWrap.querySelector(".login-field-hd, span");
    if (lab) { lab.style.transition = "opacity " + D(420) + "ms linear"; lab.style.opacity = "0"; }
    if (card) { card.style.transition = "background " + D(500) + "ms linear"; card.style.background = "rgba(10,10,10,0.2)"; }
    fadeOut(document.querySelector(".login-brand"), D(420));
    fadeOut(document.querySelector(".login-foot"), D(420));
    fadeOut(footer, D(500));
    removeAll(layer, "[data-slot]");
    removeAll(target, ".decor-fill,.decor-recs");
    target.style.transition = "opacity " + D(400) + "ms linear";
    target.style.opacity = "1";
    if (state.tabsWrap) fadeOut(state.tabsWrap, D(500));
    T(function () { fillField(tokenInput); }, D(520));
  }

  function fillField(input) {
    var host = input.parentElement;
    host.style.position = "relative";
    input.style.transition = "color " + D(300) + "ms linear";
    input.style.color = "transparent";
    input.style.caretColor = "transparent";
    var f = makeFill(host, 0, false);
    f.fill.classList.add("decor-fill-field");
    var box = input.getBoundingClientRect();
    var hb = host.getBoundingClientRect();
    f.fill.style.top = px(box.top - hb.top);
    f.fill.style.height = px(box.height);
    f.fill.style.bottom = "auto";
    reflow(f.fill);
    requestAnimationFrame(function () { f.fill.style.width = "100%"; });
    T(function () { f.stripes.style.opacity = "0"; }, D(720));
    T(function () {
      var wipe = el("decor-wipe", f.fill);
      reflow(wipe);
      requestAnimationFrame(function () { wipe.style.width = "100%"; });
      T(function () {
        input.classList.add("is-sent");
        reflow(input);
        f.fill.remove();
        sendToConsole(input);
      }, D(740));
    }, D(900));
  }

  function sendToConsole(input) {
    var lr = layer.getBoundingClientRect();
    var br = input.getBoundingClientRect();
    var tr = target.getBoundingClientRect();
    var y0 = br.top - lr.top + br.height / 2;
    var x0 = br.right - lr.left;
    var tx = tr.left - lr.left;
    var ty = tr.top - lr.top + tr.height / 2;
    var xMid = x0 + Math.max(40, (tx - x0) * 0.55);

    var h1 = seg("decor-seg-h decor-seg-fast");
    h1.style.top = px(y0 - 1); h1.style.left = px(x0); h1.style.width = "0px";
    var v = seg("decor-seg-v decor-seg-fast");
    v.style.left = px(xMid - 1); v.style.height = "0px";
    if (y0 < ty) v.style.top = px(y0 - 1); else v.style.bottom = px(lr.height - y0);
    var h2 = seg("decor-seg-h decor-seg-fast");
    h2.style.top = px(ty - 1); h2.style.left = px(xMid); h2.style.width = "0px";
    [h1, v, h2].forEach(function (s) { s.style.filter = ""; s.style.zIndex = "5"; });
    reflow(h1);
    raf2(function () { h1.style.width = px(xMid - x0); });
    T(function () { v.style.height = px(Math.abs(ty - y0)); }, D(520));
    T(function () { h2.style.width = px(tx - xMid); }, D(940));

    var dot = makeDot(x0, y0);
    dot.style.filter = ""; dot.style.zIndex = "6";
    dot.style.transition = "left " + D(520) + "ms linear";
    reflow(dot);
    raf2(function () { dot.style.left = px(xMid - 3); });
    T(function () { dot.style.transition = "top " + D(420) + "ms linear"; dot.style.top = px(ty - 3); }, D(520));
    T(function () { dot.style.transition = "left " + D(520) + "ms linear"; dot.style.left = px(tx - 3); }, D(940));

    T(function () {
      dot.style.transition = "opacity " + D(300) + "ms linear";
      dot.style.opacity = "0";
      var f = makeFill(target, 0, false);
      f.fill.classList.add("decor-fill-tgt", "decor-fill-slow");
      reflow(f.fill);
      requestAnimationFrame(function () { f.fill.style.width = "100%"; });
      T(function () { f.stripes.style.opacity = "0"; }, D(780));
      [h1, v, h2].forEach(function (s, i) {
        T(function () { s.style.transition = "opacity " + D(500) + "ms linear"; s.style.opacity = "0"; }, D(500 + i * 140));
      });
      T(floodPage, D(900));
    }, D(1460));
  }

  function floodPage() {
    if (state.flooded) return;
    state.flooded = true;
    var tr = target.getBoundingClientRect();
    var sheet = el("login-sheet", document.body);
    sheet.style.left = px(tr.left); sheet.style.top = px(tr.top);
    sheet.style.width = px(tr.width); sheet.style.height = px(tr.height);
    target.style.opacity = "0";
    reflow(sheet);
    requestAnimationFrame(function () {
      sheet.style.left = "0px"; sheet.style.top = "0px";
      sheet.style.width = "100vw"; sheet.style.height = "100vh";
      sheet.style.borderRadius = "0px";
    });
    // The real submit: HTMLFormElement.submit() bypasses the submit event, so
    // the server sees exactly the request the no-JS form would have sent.
    T(function () { form.submit(); }, D(1000));
  }

  function boot() {
    form.addEventListener("submit", function (event) {
      if (state.signing) { event.preventDefault(); return; }
      if (!form.checkValidity()) return;
      event.preventDefault();
      runSignIn();
    });
    bootDecor();
  }
`
