/**
 * `/servers` family (McpCut console): the server card internals (`.srv-*`),
 * the tools sub-panel rows, the register drawer's field grid, the two
 * confirmation interstitials and the vault table. Shared vocabulary
 * (`.card`, `.pill`, `.rows`, `.kv`, `.drawer`, `.choices`, …) comes from the
 * component/form modules; only page-specific layout lives here. Motion is
 * inherited (`.dot-blink`, `.shimmer`) and already disabled under
 * `prefers-reduced-motion` in `base.ts`.
 */
export const CSS_PAGE_SERVERS = `
/* --- Card ----------------------------------------------------------------- */
.srv-card { display: block; padding: 0; gap: 0; }
.srv-card[open] { border-color: var(--line); }
.srv-sum {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 14px 16px;
}
.srv-sum-top { flex-wrap: nowrap; min-width: 0; }
.srv-sum-top .name { flex: 1; font-size: 13px; }
.srv-sum-target { line-height: 1.6; }
.srv-sum-meta { line-height: 1.6; }
.srv-bd {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 0 16px 16px;
  border-top: 1px solid var(--rule);
  padding-top: 14px;
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
.srv-args > li::before { content: counter(arg); color: var(--fg-faint); font-variant-numeric: tabular-nums; }
.srv-args > li > code { border: none; padding: 0; }
.srv-args > li.empty { display: block; border: 1px solid var(--rule); }
.srv-args > li.empty::before { content: none; }

/* Env / headers map. */
.srv-map .kv { padding: 8px 11px; }
.srv-map .kv .v { display: flex; align-items: center; gap: 8px; min-width: 0; }
.srv-map .kv .v code { font-size: 12px; padding: 4px 8px; }
.srv-map .empty { padding: 12px; }

.srv-legend { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; line-height: 1.6; }
.srv-legend > span { display: inline-flex; align-items: center; gap: 8px; }
.srv-swatch { width: 12px; height: 12px; flex: none; display: inline-block; }
.srv-swatch-vault { background: var(--fg); }
.srv-swatch-literal { border: 1px dashed var(--line); }

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

.srv-remove { margin-left: auto; }

/* --- Register drawer ------------------------------------------------------ */
.srv-form-groups { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }
@media (max-width: 760px) { .srv-form-groups { grid-template-columns: 1fr; } }
.srv-form fieldset { margin: 0; min-width: 0; }
.srv-form legend { padding: 0 4px; }
.srv-form .callout code { border-color: var(--fg); }
.srv-no-match { grid-column: 1 / -1; }

/* --- Interstitials & vault ------------------------------------------------ */
.srv-confirm { max-width: 720px; }
.srv-confirm .callout p { margin: 0; }
.srv-confirm .callout [role="alert"] { border: none; padding: 0; }
.srv-confirm-details { padding: 0; border-top: none; animation: none; }
.srv-holders > li { padding: 9px 11px; }
.srv-holders > li code { border: none; padding: 0; }
`
