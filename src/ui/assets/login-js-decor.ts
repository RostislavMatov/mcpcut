/**
 * Decor half of `/assets/login.js` (see `login-js.ts` for the contract). A
 * faithful port of the prototype's block → route → console → stack loop and
 * its scroll-driven expansion. Plain ES5-ish JS inside a template string:
 * no `${}` (it is interpolated into the outer asset), no regex literals.
 *
 * Identifiers shared with the sign-in half (declared in `login-js.ts`):
 * `layer`, `form`, `tokenInput`, `state`, `timers`, `T`, `rnd`, `px`.
 */
export const LOGIN_JS_DECOR_SOURCE = `
  var target = layer.querySelector("[data-target]");
  var blocks = Array.prototype.slice.call(layer.querySelectorAll(".decor-block"));
  var footer = document.querySelector("[data-footer]");
  var card = document.querySelector(".login-form");
  var spacer = null;

  function el(cls, parent) {
    var d = document.createElement("div");
    d.className = cls;
    if (parent) parent.appendChild(d);
    return d;
  }
  function removeAll(root, sel) {
    var nodes = root.querySelectorAll(sel);
    for (var i = 0; i < nodes.length; i++) nodes[i].remove();
  }
  function reflow(n) { void n.offsetWidth; }
  function raf2(fn) { requestAnimationFrame(function () { requestAnimationFrame(fn); }); }

  // --- Striped white fill --------------------------------------------------
  function makeFill(host, durMs, animated) {
    var fill = el("decor-fill", null);
    var stripes = el("decor-stripes", fill);
    if (animated) { fill.classList.add("decor-fill-anim"); fill.style.animationDuration = durMs + "ms"; }
    host.appendChild(fill);
    return { fill: fill, stripes: stripes };
  }

  // --- Block life cycle ----------------------------------------------------
  function cycleBlock(b, startDelay) {
    if (state.signing) return;
    var dirs = ["login-in-left", "login-in-top", "login-in-bottom"];
    removeAll(b, ".decor-fill");
    b.style.opacity = "0";
    b.style.transform = "";
    var dir = dirs[Math.floor(Math.random() * dirs.length)];
    var dur = 1300 + rnd(600);
    b.style.animation = "none";
    reflow(b);
    b.style.animation = dir + " " + dur + "ms cubic-bezier(.16,.84,.24,1) " + startDelay + "ms forwards";
    var fillAt = startDelay + dur + 150 + rnd(1000);
    T(function () { fillThenRoute(b); }, fillAt);
  }

  function fillThenRoute(b) {
    var fillDur = 900 + rnd(700);
    var f = makeFill(b, fillDur, true);
    T(function () { f.stripes.style.opacity = "0"; }, fillDur + 120);
    T(function () { runLine(b); }, fillDur + 120 + 900);
  }

  function blockFinished(b) {
    state.doneBatch.push(b);
    if (state.doneBatch.length < 3) return;
    var batch = state.doneBatch;
    state.doneBatch = [];
    batch.sort(function () { return Math.random() - 0.5; }).forEach(function (x, i) {
      cycleBlock(x, 300 + i * 400 + rnd(900));
    });
  }

  // --- Route: block → console box --------------------------------------------
  function seg(cls) {
    var d = el("decor-seg " + cls, layer);
    d.setAttribute("data-line", "1");
    d.style.filter = "opacity(" + (1 - state.srcFade).toFixed(2) + ")";
    return d;
  }
  function makeDot(x, y) {
    var dot = el("decor-dot", layer);
    dot.setAttribute("data-line", "1");
    dot.style.top = px(y - 3);
    dot.style.left = px(x);
    el("decor-glow", dot);
    dot.style.filter = "opacity(" + (1 - state.srcFade).toFixed(2) + ")";
    return dot;
  }

  function runLine(b) {
    var lr = layer.getBoundingClientRect();
    var er = b.getBoundingClientRect();
    var tr = target.getBoundingClientRect();
    var y0 = er.top - lr.top + er.height / 2;
    var x0 = er.left - lr.left + er.width;
    var tx = tr.left - lr.left;
    var inset = 10;
    var ty = tr.top - lr.top + inset + Math.random() * Math.max(1, tr.height - inset * 2);
    var xMid = x0 + Math.max(30, (tx - x0) * (0.2 + Math.random() * 0.65));
    var eraseDur = 700;

    var erase = el("decor-erase", b);
    reflow(erase);
    requestAnimationFrame(function () { erase.style.width = "100%"; });

    var h1 = seg("decor-seg-h");
    h1.style.top = px(y0 - 1); h1.style.left = px(x0); h1.style.width = "0px";
    var v = seg("decor-seg-v");
    v.style.left = px(xMid - 1); v.style.height = "0px";
    var down = y0 < ty;
    if (down) v.style.top = px(y0 - 1); else v.style.bottom = px(lr.height - y0);
    var h2 = seg("decor-seg-h");
    h2.style.top = px(ty - 1); h2.style.left = px(xMid); h2.style.width = "0px";

    reflow(h1);
    raf2(function () { h1.style.width = px(xMid - x0); });
    T(function () { v.style.height = px(Math.abs(ty - y0)); }, 700);
    T(function () {
      h2.style.width = px(tx - xMid);
      target.classList.add("is-revealed");
      target.style.opacity = "1";
    }, 1300);

    T(function () {
      b.style.transform = "none";
      b.style.animation = "login-fade-out 900ms cubic-bezier(.4,0,.6,1) forwards";
      h1.style.transition = "left 700ms linear 90ms, width 700ms linear 90ms";
      requestAnimationFrame(function () { h1.style.left = px(xMid); h1.style.width = "0px"; });
      T(function () {
        v.style.transition = "top 600ms linear 90ms, bottom 600ms linear 90ms, height 600ms linear 90ms";
        if (!down) v.style.bottom = px(lr.height - ty); else v.style.top = px(ty - 1);
        v.style.height = "0px";
      }, 700);
      T(function () {
        h2.style.transition = "left 700ms linear 90ms, width 700ms linear 90ms";
        h2.style.left = px(tx); h2.style.width = "0px";
      }, 1300);

      var dot = makeDot(x0, y0);
      reflow(dot);
      raf2(function () { dot.style.left = px(xMid - 3); });
      T(function () { dot.style.transition = "top 600ms linear"; dot.style.top = px(ty - 3); }, 700);
      T(function () { dot.style.transition = "left 700ms linear"; dot.style.left = px(tx - 3); }, 1300);
      T(function () {
        hitTarget();
        dot.style.transition = "opacity 300ms linear";
        dot.style.opacity = "0";
        [h1, v, h2].forEach(function (s, i) {
          T(function () { s.style.transition = "opacity 600ms linear"; s.style.opacity = "0"; }, 200 + i * 160);
        });
        T(function () {
          [h1, v, h2, dot].forEach(function (n) { n.remove(); });
          blockFinished(b);
        }, 1200);
      }, 2000);
    }, eraseDur);
  }

  // --- The console box: type a record, fill, roll it out into the stack -------
  function recordLine() {
    var servers = ["fs.local", "gh.api", "pg.audit", "slack.mcp", "vec.store", "sh.runner"];
    var tools = ["list_dir", "search", "query", "post_msg", "embed", "exec"];
    var st = Math.random();
    var status = st > 0.82 ? "FAILED" : st > 0.72 ? "HELD" : "DONE";
    var now = new Date();
    var t = [now.getHours(), now.getMinutes(), now.getSeconds()].map(function (v) { return (v < 10 ? "0" : "") + v; }).join(":");
    return { server: servers[Math.floor(Math.random() * servers.length)], tool: tools[Math.floor(Math.random() * tools.length)], time: t, ms: 40 + Math.floor(Math.random() * 900), status: status };
  }
  function recordRow(rec) {
    var row = el("decor-textrow-inner", null);
    [[rec.time, "decor-t-dim"], [rec.server + "/" + rec.tool, "decor-t-name"], [rec.ms + "ms", "decor-t-dim"], [rec.status, "decor-t-status"]].forEach(function (pair) {
      var s = document.createElement("span");
      s.className = pair[1];
      s.textContent = pair[0];
      row.appendChild(s);
    });
    return row;
  }

  function typeRecord(rec) {
    var list = target.querySelector(".decor-recs");
    if (!list) list = el("decor-recs", target);
    list.setAttribute("data-stale", "0");
    list.style.opacity = String(state.wideNow);
    list.textContent = "";
    var clip = el("decor-clip", list);
    clip.appendChild(recordRow(rec));
    reflow(clip);
    requestAnimationFrame(function () { clip.style.width = "100%"; });
  }

  function hitTarget() {
    if (state.signing || state.targetBusy) return;
    state.targetBusy = true;
    var rec = recordLine();
    typeRecord(rec);
    var fill = target.querySelector(".decor-fill");
    if (!fill) { fill = makeFill(target, 0, false).fill; fill.classList.add("decor-fill-tgt"); reflow(fill); }
    fill.style.opacity = String(1 - state.wideNow);
    requestAnimationFrame(function () { fill.style.width = "100%"; });
    var stripes = fill.querySelector(".decor-stripes");
    if (stripes) { stripes.style.opacity = "1"; T(function () { stripes.style.opacity = "0"; }, 680); }
    T(function () {
      rollOut(rec);
      removeAll(target, ".decor-recs");
      fill.remove();
      state.targetBusy = false;
    }, 1100);
  }

  function rollOut(rec) {
    if (state.wideNow < 0.05) { spawnTab([rec], false); return; }
    var lr = layer.getBoundingClientRect();
    var tr = target.getBoundingClientRect();
    var wrapTop = (state.tabsWrap && parseFloat(state.tabsWrap.style.top || "0")) || (state.targetHome + target.offsetHeight + 10);
    var wrapShift = state.tabsWrap ? wrapShiftOf() : 0;
    var ghost = el("decor-ghost", layer);
    ghost.setAttribute("data-line", "1");
    ghost.style.left = px(tr.left - lr.left); ghost.style.width = px(tr.width);
    ghost.style.top = px(tr.top - lr.top); ghost.style.height = px(tr.height);
    var line = el("decor-textrow", ghost);
    line.style.opacity = String(state.wideNow);
    line.appendChild(recordRow(rec));
    reflow(ghost);
    var h = 22 + state.expand * 26;
    var slot = null;
    if (state.tabsWrap) {
      var gap = parseFloat(state.tabsWrap.style.gap || "6") || 6;
      slot = el("decor-slot", null);
      slot.setAttribute("data-slot", "1");
      slot.style.marginBottom = px(-gap);
      state.tabsWrap.insertBefore(slot, state.tabsWrap.firstChild);
      reflow(slot);
      requestAnimationFrame(function () { slot.style.height = px(h); slot.style.marginBottom = "0px"; });
    }
    requestAnimationFrame(function () { ghost.style.top = px(wrapTop + wrapShift); ghost.style.height = px(h); });
    T(function () { if (slot) slot.remove(); spawnTab([rec], true); ghost.remove(); }, 580);
  }

  function wrapShiftOf() {
    var tf = state.tabsWrap.style.transform || "";
    var m = tf.indexOf("(");
    return m === -1 ? 0 : (parseFloat(tf.slice(m + 1)) || 0);
  }

  function spawnTab(recs, instant) {
    if (state.targetHome == null) state.targetHome = target.offsetTop;
    var wrapTop = state.targetHome + 96 + 6;
    if (!state.tabsWrap) { state.tabsWrap = el("decor-tabs", layer); state.tabs = []; }
    if (wrapTop > 10) state.tabsWrap.style.top = px(wrapTop);
    var tab = el("decor-tab", null);
    var head = recs[0];
    var bars = el("decor-bars", tab);
    el("decor-knob", bars); el("decor-bar", bars); el("decor-bar2", bars);
    var textRow = el("decor-textrow", tab);
    textRow.appendChild(recordRow(head));
    bars.style.opacity = String(1 - state.wideNow);
    textRow.style.opacity = String(state.wideNow);
    state.tabsWrap.insertBefore(tab, state.tabsWrap.firstChild);
    state.tabs.unshift(tab);
    reflow(tab);
    if (instant) {
      tab.style.transition = "none";
      tab.classList.add("is-in");
      tab.style.height = px(22 + state.expand * 26);
      reflow(tab);
      tab.style.transition = "";
      restyleTabs();
    } else {
      requestAnimationFrame(function () { tab.classList.add("is-in"); requestAnimationFrame(restyleTabs); });
    }
    state.wrapTop = wrapTop;
    sizeSpacer();
    var fits = tabCapacity();
    while (state.tabs.length > fits) {
      var old = state.tabs.pop();
      old.setAttribute("data-dying", "1");
      var g = parseFloat(state.tabsWrap.style.gap || "6") || 6;
      old.style.transition = "none";
      old.style.height = px(old.offsetHeight);
      reflow(old);
      old.style.transition = "opacity 260ms linear, height 380ms cubic-bezier(.3,.8,.3,1), margin-bottom 380ms cubic-bezier(.3,.8,.3,1), border-width 380ms cubic-bezier(.3,.8,.3,1)";
      old.style.opacity = "0";
      (function (o) {
        requestAnimationFrame(function () { o.style.height = "0px"; o.style.borderWidth = "0px"; o.style.marginBottom = px(-g); });
        T(function () { o.remove(); }, 460);
      })(old);
    }
    restyleTabs();
  }

  function tabCapacity() {
    var footH = footer ? footer.offsetHeight : 205;
    var room = window.innerHeight - 44 - 48 - 14 - 24 - footH - 24;
    return Math.max(3, Math.floor((room + 14) / 62));
  }
  function sizeSpacer() {
    if (!spacer) return;
    spacer.style.height = px(Math.round(window.innerHeight * 0.55 + 140));
  }

  // --- Scroll-driven expansion ---------------------------------------------
  function restyleTabs() {
    if (state.signing) return;
    var n = state.tabs.length;
    var p = state.expand;
    state.wideNow = Math.max(0, Math.min(1, (p - 0.5) / 0.3));
    var lw = layer.getBoundingClientRect().width;
    var wrapLeft = lw - 24 - 200;
    var fade = Math.min(1, p / 0.45);
    var q = Math.max(0, Math.min(1, (p - 0.5) / 0.5));
    var grow = Math.max(0, wrapLeft - 44) * q;
    if (card) {
      card.style.opacity = String(1 - fade);
      card.style.transform = "translateY(" + (-30 * fade).toFixed(1) + "px)";
      card.style.pointerEvents = fade > 0.6 ? "none" : "auto";
    }
    state.srcFade = fade;
    if (state.targetHome == null) state.targetHome = target.offsetTop;
    var targetH = 96 - 48 * p;
    var gapNow = 6 + p * 8;
    var rowHNow = 22 + p * 26;
    var stackH = n * rowHNow + Math.max(0, n - 1) * gapNow;
    var footDocTop = footer ? footer.getBoundingClientRect().top + window.scrollY : Infinity;
    var flowPlace = state.targetHome + targetH + gapNow;
    var pinnedPlace = window.scrollY + 44 + targetH + gapNow;
    var ceilPlace = footDocTop - 32 - stackH;
    var place = Math.min(Math.max(flowPlace, pinnedPlace), Math.max(flowPlace, ceilPlace));
    var rise = Math.max(0, place - gapNow - targetH - state.targetHome);
    target.style.width = px(200 + grow);
    target.style.height = px(targetH);
    target.style.transform = "translateY(" + rise + "px)";
    var recs = target.querySelector(".decor-recs");
    if (recs) recs.style.opacity = String((recs.getAttribute("data-stale") === "1" ? 0.32 : 1) * state.wideNow);
    var tf = target.querySelector(".decor-fill");
    if (tf) tf.style.opacity = String(1 - state.wideNow);
    if (state.tabsWrap) {
      var wrapDocTop = parseFloat(state.tabsWrap.style.top || "0");
      state.tabsWrap.style.transform = "translateY(" + (place - wrapDocTop) + "px)";
      state.tabsWrap.style.gap = px(6 + p * 8);
      state.tabsWrap.style.width = px(200 + grow);
    }
    var f = "opacity(" + (1 - fade).toFixed(2) + ")";
    blocks.forEach(function (b) { b.style.filter = f; });
    var lines = layer.querySelectorAll("[data-line]");
    for (var i = 0; i < lines.length; i++) lines[i].style.filter = f;
    var dim = 0.3 + 0.7 * fade;
    var mask = "linear-gradient(90deg, #000 0, #000 24%, rgba(0,0,0," + dim + ") 38%, rgba(0,0,0," + dim + ") 62%, #000 76%, #000 100%)";
    layer.style.maskImage = mask;
    layer.style.webkitMaskImage = mask;
    state.tabs.forEach(function (t, i) {
      if (!t.isConnected || t.getAttribute("data-dying") === "1") return;
      t.style.height = px(22 + p * 26);
      var tRow = t.querySelector(".decor-textrow");
      var tBars = t.querySelector(".decor-bars");
      if (tRow) tRow.style.opacity = String(state.wideNow);
      if (tBars) tBars.style.opacity = String(1 - state.wideNow);
      if (n < 2) { t.style.filter = "none"; t.style.opacity = "1"; return; }
      var depth = i / Math.max(3, n - 1);
      t.style.filter = "blur(" + (depth * depth * 3.4 * (1 - p)).toFixed(2) + "px)";
      var d = Math.max(0.12, 1 - depth * 0.9);
      t.style.opacity = String(d + (1 - d) * p);
    });
  }

  function resetPaths() {
    timers.forEach(clearTimeout);
    timers.length = 0;
    removeAll(layer, "[data-line],[data-slot]");
    state.targetBusy = false;
    state.doneBatch = [];
    removeAll(target, ".decor-fill,.decor-recs");
    blocks.forEach(function (b, i) {
      removeAll(b, ".decor-fill,.decor-erase");
      var placed = parseFloat(getComputedStyle(b).opacity) > 0.9;
      if (placed) {
        b.style.animation = "none"; b.style.opacity = "1"; b.style.transform = "none";
        T(function () { fillThenRoute(b); }, 200 + i * 220 + rnd(900));
      } else {
        cycleBlock(b, 120 + i * 90 + rnd(1400));
      }
    });
  }

  var pathScroll = null, resetT = null;
  function onScroll() {
    if (pathScroll == null) pathScroll = window.scrollY;
    if (Math.abs(window.scrollY - pathScroll) > 24) {
      pathScroll = window.scrollY;
      clearTimeout(resetT);
      resetT = setTimeout(resetPaths, 180);
    }
    var max = Math.max(1, window.innerHeight * 0.55);
    state.expand = Math.max(0, Math.min(1, window.scrollY / max));
    restyleTabs();
  }
  function fitDecor() { layer.classList.toggle("is-hidden", window.innerWidth < 900); }

  function bootDecor() {
    fitDecor();
    window.addEventListener("resize", fitDecor);
    spacer = el("login-spacer", null);
    if (footer) footer.parentElement.insertBefore(spacer, footer); else document.body.appendChild(spacer);
    sizeSpacer();
    window.addEventListener("scroll", onScroll, { passive: true });
    blocks.forEach(function (b) { cycleBlock(b, 120 + rnd(1700)); });
    onScroll();
  }
`
