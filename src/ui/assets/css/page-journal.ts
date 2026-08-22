/**
 * `/journal` — the journal browser in the "Call journal" row grammar of the
 * McpCut design: a caps header row, hair-line rows with hover, the filter bar
 * under the panel head, and one disclosure per record whose summary is the
 * row and whose body is the redacted payload. Column templates switch on the
 * panel's modifier classes (`jr-has-lat`, `jr-with-session`) so the header and
 * the rows always share one grid.
 */
export const CSS_PAGE_JOURNAL = `
.jr-panel .panel-hd h1 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.jr-filter-bar { padding: 10px 16px; border-bottom: 1px solid var(--rule); }
.jr-filters input { width: 110px; }
.jr-filters input[type="search"] { flex: 1 1 160px; width: auto; min-width: 140px; }
.jr-notices { display: flex; flex-direction: column; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--rule); }
.jr-notices .scan-notice, .jr-notices .notice { margin: 0; }
.jr-panel .empty { border: none; border-radius: 0; }

/* --- Row grid --------------------------------------------------------------- */
.jr-row {
  display: grid;
  gap: 12px;
  align-items: center;
  padding: 9px 16px;
  font-size: 12px;
  color: var(--fg);
  border: none;
  border-bottom: 1px solid var(--hair);
  min-width: 0;
}
.jr-row-hd { border-bottom: 2px solid var(--rule); }
.jr-rows { display: flex; flex-direction: column; }
.jr-rows > :last-child, .jr-rows > details:last-child > summary { border-bottom-color: transparent; }
a.jr-row:hover, details.jr-rec > summary.jr-row:hover { background: var(--hover-bg); border-bottom-color: var(--hair); }

/* Session list: Session · Records · Unreadable · First · Last */
.jr-row.jr-session { grid-template-columns: minmax(0, 1.6fr) 80px 90px minmax(0, 1fr) minmax(0, 1fr); }
.jr-row.jr-session .num { text-align: right; }
.jr-session-id { font-family: var(--font-pixel); font-size: 11px; letter-spacing: 0.04em; }

/* Records: Time · Message · State (· Lat), optionally led by Session */
.jr-panel .jr-row.jr-record, .jr-panel .jr-row.jr-row-hd:not(.jr-session) {
  grid-template-columns: 70px minmax(0, 1fr) auto;
}
.jr-panel.jr-has-lat .jr-row.jr-record, .jr-panel.jr-has-lat .jr-row.jr-row-hd:not(.jr-session) {
  grid-template-columns: 70px minmax(0, 1fr) auto 72px;
}
.jr-panel.jr-with-session .jr-row.jr-record, .jr-panel.jr-with-session .jr-row.jr-row-hd:not(.jr-session) {
  grid-template-columns: minmax(0, 0.8fr) 70px minmax(0, 1.4fr) auto;
}
.jr-panel.jr-with-session.jr-has-lat .jr-row.jr-record, .jr-panel.jr-with-session.jr-has-lat .jr-row.jr-row-hd:not(.jr-session) {
  grid-template-columns: minmax(0, 0.8fr) 70px minmax(0, 1.4fr) auto 72px;
}
.jr-row .jr-lat { text-align: right; }
.jr-state { display: inline-flex; gap: 6px; justify-content: flex-end; white-space: nowrap; }
.jr-what .method, .jr-what .tool-name { color: var(--fg); }
.jr-what .server { color: var(--fg-dim); }
.jr-decision > summary .jr-what { font-family: var(--font-pixel); font-size: 11px; letter-spacing: 0.04em; }
.jr-decision > summary .jr-agent { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0; }
.jr-row .session-link { border: none; font-family: var(--font-pixel); font-size: 11px; letter-spacing: 0.04em; }
.jr-row .session-link:hover { text-decoration: underline; }

/* Disclosure body: rule line + payload */
details.jr-rec > summary { cursor: pointer; }
details.jr-rec[open] > summary { background: var(--hover-bg); border-bottom-color: var(--hair); }
.jr-rec-bd {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 16px 14px 98px;
  border-bottom: 1px solid var(--hair);
  animation: row-in 180ms steps(4);
}
.jr-with-session .jr-rec-bd { padding-left: 16px; }
.jr-rec-bd .payload { max-height: 320px; }
.jr-rec-bd .rule { color: var(--fg-dim); }
@media (max-width: 820px) {
  .jr-row.jr-session { grid-template-columns: minmax(0, 1fr) 70px 80px; }
  .jr-row.jr-session > :nth-child(4), .jr-row.jr-session > :nth-child(5) { display: none; }
  .jr-rec-bd { padding-left: 16px; }
}
`
