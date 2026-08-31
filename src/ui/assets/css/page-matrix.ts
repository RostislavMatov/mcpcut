/**
 * Page-specific layout for the `matrix` page family of the McpCut console:
 * `/quarantine` (`.qr-*`), `/agents` (`.ag-*`) and `/admins` (`.ad-*`) plus
 * their token-once and notice pages. Only layout lives here — card internals,
 * matrix columns, drawer form grids; every control, pill and panel is the
 * shared component from `components.ts` / `forms.ts`.
 */
export const CSS_PAGE_MATRIX = `
/* --- Quarantine ------------------------------------------------------------ */
.qr-panel .quarantine { display: flex; flex-direction: column; }
.qr-panel .empty { border: none; border-radius: 0; }
.qr-cards { display: flex; flex-direction: column; }
.qr-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--rule);
}
.qr-card:last-child { border-bottom: none; }
.qr-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
.qr-tool { font-size: 13px; }
.qr-tool .server { color: var(--fg-dim); }
.qr-seen { margin-left: auto; }
.qr-desc { font-size: 11px; color: var(--fg-dim); max-width: 72ch; word-break: break-word; }
.qr-desc .qr-trunc { margin-left: 6px; }
.qr-diff .qr-change {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 11px;
}
.qr-diff .qr-change > .label { margin-left: auto; color: var(--fg-dim); }
.qr-diff .qr-change-truncated { border-top: 2px solid var(--fg); color: var(--fg); }
.qr-diff .qr-change-truncated .small { flex: 1; min-width: 220px; line-height: 1.5; }
.qr-diff .empty { padding: 11px; }
.qr-card .actions form { flex: 1; display: flex; }
.qr-card .actions button { flex: 1; min-width: 110px; }

/* --- Agents ---------------------------------------------------------------- */
.ag-panel .panel-hd .row { gap: 14px; }
.ag-drawers { align-items: start; }
@media (max-width: 860px) { .ag-drawers { grid-template-columns: 1fr; } }
.ag-grant-who, .ag-grant-dims { display: grid; gap: 12px; }
.ag-grant-who { grid-template-columns: 1fr 1fr; }
.ag-grant-dims { grid-template-columns: repeat(3, minmax(0, 1fr)); }
@media (max-width: 640px) { .ag-grant-who, .ag-grant-dims { grid-template-columns: 1fr; } }
.ag-panel .empty { border-style: dashed; }
.ag-card { gap: 12px; }
.ag-card .table-wrap { border-color: var(--hair); }
.ag-matrix th:last-child, .ag-matrix td.ag-ungrant { width: 1%; white-space: nowrap; text-align: right; }
.ag-matrix td.ag-source { white-space: nowrap; }
.ag-matrix td.ag-source .small { margin-left: 8px; }
.ag-matrix td.ag-server { font-family: var(--font-pixel); font-size: 11px; letter-spacing: 0.04em; }
.ag-matrix td code { margin: 1px 0; display: inline-block; }
.ag-foot { display: flex; justify-content: flex-end; align-items: center; gap: 10px; }
.ag-notice, .ad-notice { display: flex; flex-direction: column; gap: 10px; padding: 16px; }
.ag-notice p, .ad-notice p { font-size: 12px; }

/* --- "this ungrant widens access" interstitial ------------------------------ */
.ag-confirm { max-width: 720px; }
.ag-confirm .callout p { margin: 0; }
.ag-confirm .callout [role='alert'] { border: none; padding: 0; }
.ag-confirm .actions { display: flex; gap: 10px; justify-content: flex-end; }
.ag-holders { margin-top: 4px; }
.ag-fallback th { text-align: left; white-space: nowrap; width: 1%; }
.ag-fallback td code { margin: 1px 0; display: inline-block; }

/* --- Admins ---------------------------------------------------------------- */
.ad-add-grid .choice { flex-direction: row; }
.ad-add-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr); gap: 14px; align-items: end; }
@media (max-width: 640px) { .ad-add-grid { grid-template-columns: 1fr; } }
.ad-roster td.ad-name { font-size: 11px; }
.ad-roster td.num { white-space: nowrap; }
.ad-actions { justify-content: flex-end; }
.ad-actions select { padding: 7px 28px 7px 10px; font-size: 11px; }
.ad-actions button { padding: 8px 12px; }
`
