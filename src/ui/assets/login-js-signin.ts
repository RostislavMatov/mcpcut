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
 */
export const LOGIN_JS_SIGNIN_SOURCE = `
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
      ch.style.transition = "opacity 420ms linear, transform 420ms cubic-bezier(.4,0,.6,1)";
      ch.style.opacity = "0";
      ch.style.transform = "translateY(-6px)";
      ch.style.pointerEvents = "none";
    });
    var lab = keepWrap.querySelector(".login-field-hd, span");
    if (lab) { lab.style.transition = "opacity 420ms linear"; lab.style.opacity = "0"; }
    if (card) { card.style.transition = "background 500ms linear"; card.style.background = "rgba(10,10,10,0.2)"; }
    fadeOut(document.querySelector(".login-brand"), 420);
    fadeOut(document.querySelector(".login-foot"), 420);
    fadeOut(footer, 500);
    removeAll(layer, "[data-slot]");
    removeAll(target, ".decor-fill,.decor-recs");
    target.style.transition = "opacity 400ms linear";
    target.style.opacity = "1";
    if (state.tabsWrap) fadeOut(state.tabsWrap, 500);
    T(function () { fillField(tokenInput); }, 520);
  }

  function fillField(input) {
    var host = input.parentElement;
    host.style.position = "relative";
    input.style.transition = "color 300ms linear";
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
    T(function () { f.stripes.style.opacity = "0"; }, 720);
    T(function () {
      var wipe = el("decor-wipe", f.fill);
      reflow(wipe);
      requestAnimationFrame(function () { wipe.style.width = "100%"; });
      T(function () {
        input.classList.add("is-sent");
        reflow(input);
        f.fill.remove();
        sendToConsole(input);
      }, 740);
    }, 900);
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
    T(function () { v.style.height = px(Math.abs(ty - y0)); }, 520);
    T(function () { h2.style.width = px(tx - xMid); }, 940);

    var dot = makeDot(x0, y0);
    dot.style.filter = ""; dot.style.zIndex = "6";
    dot.style.transition = "left 520ms linear";
    reflow(dot);
    raf2(function () { dot.style.left = px(xMid - 3); });
    T(function () { dot.style.transition = "top 420ms linear"; dot.style.top = px(ty - 3); }, 520);
    T(function () { dot.style.transition = "left 520ms linear"; dot.style.left = px(tx - 3); }, 940);

    T(function () {
      dot.style.transition = "opacity 300ms linear";
      dot.style.opacity = "0";
      var f = makeFill(target, 0, false);
      f.fill.classList.add("decor-fill-tgt", "decor-fill-slow");
      reflow(f.fill);
      requestAnimationFrame(function () { f.fill.style.width = "100%"; });
      T(function () { f.stripes.style.opacity = "0"; }, 780);
      [h1, v, h2].forEach(function (s, i) {
        T(function () { s.style.transition = "opacity 500ms linear"; s.style.opacity = "0"; }, 500 + i * 140);
      });
      T(floodPage, 900);
    }, 1460);
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
    T(function () { form.submit(); }, 1000);
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
