/**
 * `/` — the Dashboard, laid out exactly as Dashboard.dc.html of the McpCut
 * design (2026-08-24): four sparkline tiles in a fixed row, then a
 * 1.9fr/1fr grid — the call journal table on the left, the approval queue
 * (white border) stacked over the call-detail card on the right — and the
 * servers grid with activity bars along the bottom. Sparkline/bar heights and
 * widths are class buckets (`.tb-h*`, `.svw-*`) because the CSP forbids
 * inline styles; the markup picks a bucket deterministically.
 */
export const CSS_PAGE_DASHBOARD = `
.dash-tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); }
@media (max-width: 900px) { .dash-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.tile { border-bottom: 2px solid var(--rule); color: var(--fg); }
a.tile:hover { border-color: var(--line); }
.tile-strong, a.tile-strong:hover { border-color: var(--fg); }

.tile-bars, .tile-strong .tile-bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 26px;
  background: none;
}
.tb { flex: 1 1 0; min-width: 2px; background: rgba(255, 255, 255, 0.3); }
.tb.on { background: var(--fg); }
.tb-h0 { height: 5px; }
.tb-h1 { height: 8px; }
.tb-h2 { height: 11px; }
.tb-h3 { height: 14px; }
.tb-h4 { height: 17px; }
.tb-h5 { height: 20px; }
.tb-h6 { height: 23px; }
.tb-h7 { height: 26px; }

.dash-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.9fr) minmax(280px, 1fr);
  gap: var(--gap);
  align-items: stretch;
}
@media (max-width: 960px) { .dash-grid { grid-template-columns: 1fr; } }
.dash-side { display: flex; flex-direction: column; gap: var(--gap); min-width: 0; }

.dash-queue .approvals { display: flex; flex-direction: column; }
.dash-queue .pending-count {
  padding: 9px 16px;
  border-bottom: 2px solid var(--rule);
  margin: 0;
}
.dash-queue .empty { border: none; border-radius: 0; }
.queue-cards {
  display: flex;
  flex-direction: column;
  max-height: 490px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--fg) var(--hair);
}
.approval-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--rule);
}
.approval-card:last-child { border-bottom: none; }
.approval-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
.approval-head .tool { font-size: 13px; }
.approval-head .server { color: var(--fg-dim); }
.approval-head .agent { margin-left: auto; font-size: 11px; }
.approval-card .args { max-height: 180px; }
.clocks { display: flex; gap: 16px; flex-wrap: wrap; font-size: 11px; color: var(--fg-mute); }
.clocks > span { display: inline-flex; align-items: center; gap: 8px; }
.clocks .wait-elapsed { color: var(--fg-dim); }
.approval-card .actions button { flex: 1; min-width: 110px; }
.approval-card .actions form { flex: 1; display: flex; }
.approval-card .bulk-select { font-size: 11px; color: var(--fg-mute); }

.dash-recent { display: flex; flex-direction: column; min-width: 0; }
.dash-recent .panel-hd { flex-wrap: wrap; gap: 10px; }
.jf-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
a.jf {
  padding: 6px 9px;
  border: 2px solid var(--rule);
  border-radius: 4px;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-dim);
}
a.jf:hover { border-color: var(--line); color: var(--fg); }
a.jf.is-on, a.jf.is-on:hover { border-color: var(--fg); background: var(--fg); color: var(--bg); }
.dash-rows-hd, .dash-row {
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr) 62px 96px;
  gap: 14px;
  align-items: center;
  padding: 10px 16px;
}
.dash-rows-hd { border-bottom: 2px solid var(--rule); }
.dash-rows-hd span:nth-child(3), .dash-rows-hd span:last-child { text-align: right; }
.dash-rows {
  flex: 1;
  display: flex;
  flex-direction: column;
  max-height: 560px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--fg) var(--hair);
}
.dash-row { border-bottom: 1px solid var(--hair); color: var(--fg); font-size: 12px; }
.dash-row:hover { background: var(--hover-bg); border-bottom-color: var(--hair); }
.dash-row.is-sel { background: rgba(255, 255, 255, 0.08); }
.dash-row .lat { text-align: right; color: var(--fg-dim); }
.dash-row .outcome { text-align: right; font-size: 10px; letter-spacing: 0.12em; color: var(--fg-dim); }
.dash-row .outcome-deny, .dash-row .outcome-denied, .dash-row .outcome-quarantine, .dash-row .outcome-quarantined { color: var(--fg); }
.dash-recent .empty { border: none; border-radius: 0; }
.dash-recent .panel-ft { margin-top: auto; }

.dash-detail .kv-rows {
  display: flex;
  flex-direction: column;
  gap: 9px;
  font-size: 12px;
}
.kv-line { display: flex; justify-content: space-between; gap: 14px; }
.kv-line .kv-v { text-align: right; }
.dash-detail-bd { display: flex; flex-direction: column; gap: 12px; padding: 14px; }
.detail-args {
  padding: 11px 12px;
  border: 1px solid var(--rule);
  border-radius: 5px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--fg-dim);
  overflow-wrap: anywhere;
}
a.detail-open {
  padding: 11px 12px;
  border: 2px solid var(--line);
  border-radius: 6px;
  text-align: center;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--fg);
}
a.detail-open:hover { border-color: var(--fg); }
.dash-detail .empty { border: none; border-radius: 0; }

.dash-servers { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
.dash-server {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 14px 16px;
  border-right: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
  color: var(--fg);
  min-width: 0;
}
.dash-server:hover { background: var(--hover-bg); border-bottom-color: var(--rule); }
.dash-server .name { font-size: 13px; }
.sv-bar { height: 4px; background: var(--rule); overflow: hidden; }
.sv-bar span { display: block; height: 100%; background: var(--fg); }
.sv-bar .svw-0 { width: 12%; }
.sv-bar .svw-1 { width: 26%; }
.sv-bar .svw-2 { width: 40%; }
.sv-bar .svw-3 { width: 54%; }
.sv-bar .svw-4 { width: 68%; }
.sv-bar .svw-5 { width: 82%; }
.sv-bar .svw-6 { width: 96%; }
.sv-bar .svw-7 { width: 100%; }
`
