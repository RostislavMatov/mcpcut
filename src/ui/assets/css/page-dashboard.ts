/**
 * `/` — the Dashboard: tiles, the approval queue panel beside the recent
 * decisions, and the servers strip. Also the approval card itself, which is
 * the dashboard's centre of gravity.
 */
export const CSS_PAGE_DASHBOARD = `
.dash-tiles { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
.tile { border-bottom: 2px solid var(--rule); color: var(--fg); }
a.tile { border-bottom-width: 2px; }
a.tile:hover { border-color: var(--line); }
.tile-strong, a.tile-strong:hover { border-color: var(--fg); }

.dash-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.9fr) minmax(300px, 1fr);
  gap: var(--gap);
  align-items: start;
}
@media (max-width: 960px) { .dash-grid { grid-template-columns: 1fr; } }

.dash-queue .approvals { display: flex; flex-direction: column; }
.dash-queue .pending-count {
  padding: 9px 16px;
  border-bottom: 2px solid var(--rule);
  margin: 0;
}
.dash-queue .empty { border: none; border-radius: 0; }
.queue-cards { display: flex; flex-direction: column; }
.approval-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px;
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

.dash-recent .panel-hd a { font-size: 11px; }
.dash-rows-hd, .dash-row {
  display: grid;
  grid-template-columns: 70px minmax(0, 1.6fr) minmax(0, 1fr) 92px;
  gap: 12px;
  align-items: center;
  padding: 9px 14px;
}
.dash-rows-hd { border-bottom: 2px solid var(--rule); }
.dash-rows { display: flex; flex-direction: column; max-height: 560px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--fg) var(--hair); }
.dash-row { border-bottom: 1px solid var(--hair); color: var(--fg); font-size: 12px; }
.dash-row:hover { background: var(--hover-bg); border-bottom-color: var(--hair); }
.dash-row .outcome { text-align: right; font-size: 10px; letter-spacing: 0.12em; color: var(--fg-dim); }
.dash-row .outcome-deny, .dash-row .outcome-denied, .dash-row .outcome-quarantine, .dash-row .outcome-quarantined { color: var(--fg); }
.dash-rows-hd span:last-child { text-align: right; }
.dash-recent .empty { border: none; border-radius: 0; }

.dash-servers { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.dash-server {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border-right: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
  color: var(--fg);
  min-width: 0;
}
.dash-server:hover { background: var(--hover-bg); border-bottom-color: var(--rule); }
.dash-server .pixel { font-size: 13px; }
.dash-server .pill { align-self: flex-start; }
`
