/**
 * `/servers` family, laid out as Servers.dc.html of the McpCut design
 * (2026-08-24): white-bordered server cards in two switchable views — square
 * tiles (an open card spans two columns, so opening one never stretches its
 * neighbours: `align-items: start` + per-card `aspect-ratio`) or a full-width
 * list — plus the modal register/edit drawer (`details[open]` styled as the
 * centred overlay; its summary is visually hidden because the design has no
 * in-page register button, the tab bar's `+` is the entry). The form shows
 * only the checked transport's group via `:has()`; browsers without `:has`
 * simply show both groups — the schema, not the CSS, is what rejects fields
 * of the other transport.
 */
export const CSS_PAGE_SERVERS = `
/* --- Grid / list views ---------------------------------------------------- */
.srv-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
  align-items: start;
}
.srv-grid.view-list { display: flex; flex-direction: column; align-items: stretch; gap: 8px; }
.view-grid .srv-card:not([open]) { aspect-ratio: 1 / 1; min-height: 168px; overflow: hidden; }
.view-grid .srv-card[open] { grid-column: span 2; }
@media (max-width: 560px) { .view-grid .srv-card[open] { grid-column: auto; } }

.view-toggle { display: flex; align-items: stretch; border: 2px solid var(--line); border-radius: 5px; overflow: hidden; }
.view-toggle a { width: 32px; padding: 7px 0; text-align: center; font-size: 13px; line-height: 1; color: var(--fg-dim); }
.view-toggle a:hover { color: var(--fg); }
.view-toggle a.is-on { background: var(--fg); color: var(--bg); }

/* --- Card ----------------------------------------------------------------- */
.srv-card { display: block; padding: 0; gap: 0; border: 2px solid var(--fg); border-radius: 8px; }
.srv-sum {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 11px 12px;
  cursor: pointer;
}
.srv-sum:hover { background: var(--hover-bg); }
.view-grid .srv-card:not([open]) .srv-sum { height: 100%; }
.srv-card[open] .srv-sum { border-bottom: 2px solid var(--rule); }
.view-list .srv-sum { flex-direction: row; align-items: center; gap: 16px; padding: 10px 14px; }
.view-list .srv-sum > * { min-width: 0; }
.srv-sum-top { flex-wrap: nowrap; min-width: 0; }
.srv-sum-top .name { font-size: 11px; }
.srv-sum-badges { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tpill {
  padding: 4px 9px;
  border-radius: 4px;
  font-family: var(--font-pixel);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.tpill-stdio { border: 2px solid var(--fg); background: var(--fg); color: var(--bg); }
.tpill-http { border: 2px solid var(--line); background: var(--bg); color: var(--fg); }
.srv-sum .spacer-v { flex: 1; }
.srv-sum-target { line-height: 1.6; }
.srv-sum-meta { line-height: 1.6; }
.view-list .srv-sum-target { flex: 1; }
.srv-bd {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 16px 16px;
  animation: row-in 180ms steps(4);
}
.srv-field { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.srv-box {
  font-size: 13px;
  padding: 9px 11px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  word-break: break-all;
}

/* Args: one argument per row, numbered by counter so the markup stays <li><code>. */
.srv-args { counter-reset: arg; display: flex; flex-direction: column; gap: 4px; }
.srv-args > li {
  counter-increment: arg;
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  padding: 7px 10px;
  border: 1px solid var(--rule);
  border-radius: var(--radius-s);
  font-size: 12px;
}
.srv-args > li::before { content: counter(arg, decimal-leading-zero); color: var(--fg-faint); font-variant-numeric: tabular-nums; }
.srv-args > li > code { border: none; padding: 0; }
.srv-args > li.empty { display: block; border: 1px solid var(--rule); }
.srv-args > li.empty::before { content: none; }

/* Env / headers map. */
.srv-map .kv { padding: 9px 11px; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); }
.srv-map .kv .v { display: flex; align-items: center; gap: 8px; min-width: 0; }
.srv-map .kv .v code { font-size: 12px; padding: 4px 8px; }
.srv-map .empty { padding: 12px; }

.srv-legend { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; line-height: 1.6; }
.srv-legend > span { display: inline-flex; align-items: center; gap: 8px; }
.srv-swatch { width: 12px; height: 12px; flex: none; display: inline-block; }
.srv-swatch-vault { background: var(--fg); }
.srv-swatch-literal { border: 1px dashed var(--line); }

/* Actions: Edit (solid pixel) + Remove (outline), as the design's expanded card. */
.srv-actions { display: flex; gap: 8px; padding-top: 4px; }
a.btn.srv-edit {
  padding: 9px 14px;
  border: 2px solid var(--fg);
  border-radius: 5px;
  background: var(--fg);
  color: var(--bg);
  font-family: var(--font-pixel);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
a.btn.srv-edit:hover { background: var(--bg); color: var(--fg); }
.srv-remove { margin-left: 0; }

/* --- Tools sub-panel ------------------------------------------------------ */
.srv-tools { border: 2px solid var(--fg); border-radius: var(--radius); overflow: hidden; }
.srv-tools-sum { display: flex; align-items: center; gap: 12px; padding: 11px 12px; }
.srv-tools-sum:hover { background: var(--select-bg); }
.srv-tools-sum .pixel { font-size: 10px; }
.srv-tools[open] > .srv-tools-sum { border-bottom: 2px solid var(--rule); }
.srv-tool-rows { border: none; border-radius: 0; max-height: 420px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--fg) var(--hair); }
.srv-tool { display: flex; flex-direction: column; gap: 6px; }
.srv-tool:hover { background: var(--hover-bg); }
.srv-tool-name { font-size: 12px; word-break: break-all; }
.srv-tool-desc { font-size: 11px; }
.srv-tool .row { flex-wrap: wrap; }
.srv-tool-rows .empty { padding: 14px; }

/* --- Modal drawer (register / edit) --------------------------------------- */
.srv-drawer { border: none; padding: 0; }
.srv-drawer > summary.srv-drawer-sum {
  padding: 0;
  margin: 0;
  border: 0;
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.srv-drawer[open] {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(0, 0, 0, 0.82);
  background-image: linear-gradient(rgba(255, 255, 255, 0.04) 1px, transparent 1px);
  background-size: 100% 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}
.srv-modal {
  width: 100%;
  max-width: 520px;
  max-height: 100%;
  overflow-y: auto;
  border: 2px solid var(--fg);
  border-radius: 8px;
  background: var(--bg);
  box-shadow: 12px 12px 0 rgba(255, 255, 255, 0.12);
  animation: row-in 180ms steps(4);
  scrollbar-width: thin;
  scrollbar-color: var(--fg) var(--hair);
}
.srv-modal-hd {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg);
  padding: 12px 14px;
  border-bottom: 2px solid var(--rule);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.srv-modal-hd .pixel { font-size: 12px; letter-spacing: 0.06em; }
a.icon.srv-modal-x {
  width: 26px;
  height: 26px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--line);
  border-radius: 4px;
  color: var(--fg);
  font-size: 12px;
  line-height: 1;
}
a.icon.srv-modal-x:hover { border-color: var(--fg); }
.srv-modal > [role='alert'] { margin: 14px 14px 0; }

/* --- The form ------------------------------------------------------------- */
.srv-form { display: flex; flex-direction: column; gap: 14px; padding: 14px; }
.srv-form .grp {
  margin: 0;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  animation: row-in 220ms steps(4);
}
.srv-form legend { padding: 0 4px; }
.srv-form:has(input[name='transport'][value='http']:checked) .grp-stdio { display: none; }
.srv-form:has(input[name='transport'][value='stdio']:checked) .grp-http { display: none; }
.srv-form .choices { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.srv-form .grp-http .choices { grid-template-columns: repeat(3, 1fr); }
.srv-form .choices .choice { justify-content: center; }
.srv-form .callout { display: block; }
.srv-form .callout code { border-color: var(--fg); white-space: nowrap; }
.srv-form .form-actions { display: flex; gap: 10px; }
.srv-form .form-actions button[type='submit'] { flex: 1; }
.srv-form input[readonly] { color: var(--fg-dim); border-style: dashed; }
.srv-no-match { grid-column: 1 / -1; }

/* --- Interstitials & vault ------------------------------------------------ */
.srv-confirm { max-width: 720px; }
.srv-confirm .callout p { margin: 0; }
.srv-confirm .callout [role='alert'] { border: none; padding: 0; }
.srv-confirm-details { padding: 0; border-top: none; animation: none; }
.srv-holders > li { padding: 9px 11px; }
.srv-holders > li code { border: none; padding: 0; }
`
