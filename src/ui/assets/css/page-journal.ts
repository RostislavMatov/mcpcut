/**
 * `/journal` — the journal browser in the "Call journal" row grammar of the
 * McpCut design, redrawn from Claude Design `Journal.dc.html` (2026-08-27):
 * `Sessions`/`Records` tabs in the panel head, a one-line filter bar that ends
 * in the period control, a caps header row, hair-line rows with hover, and one
 * disclosure per record whose summary is the row and whose body is the
 * redacted payload.
 *
 * Two structural notes:
 * - the record grid is fixed (`Time · Message · State · Lat`, optionally led by
 *   `Session`) rather than switching on whether the page happens to carry a
 *   latency, so the columns do not move as an operator pages through a session;
 * - `.jr-panel` deliberately does NOT clip its overflow: the period popover is
 *   absolutely positioned inside the filter bar, and a clipping panel would cut
 *   it off. Nothing inside the panel paints a background into the rounded
 *   corners, so the radius survives without the clip.
 */
export const CSS_PAGE_JOURNAL = `
.jr-panel { overflow: visible; }
.jr-panel .panel-hd h1 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.jr-panel .panel-hd > .num { min-width: 0; }
.jr-filter-bar { padding: 10px 16px; border-bottom: 1px solid var(--rule); }
.jr-notices { display: flex; flex-direction: column; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--rule); }
.jr-notices .scan-notice, .jr-notices .notice { margin: 0; }
.jr-panel .empty { border: none; border-radius: 0; }
.jr-back { margin: 0; }

/* --- Tabs ----------------------------------------------------------------- */
.jr-tabs { display: flex; align-items: center; gap: 8px; }
.jr-tab {
  display: inline-flex;
  align-items: center;
  padding: 9px 14px;
  border: 2px solid var(--rule);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--fg-dim);
  font-family: var(--font-pixel);
  font-size: 11px;
  letter-spacing: var(--track-s);
  text-transform: uppercase;
  line-height: 1;
}
.jr-tab:hover { border-color: var(--fg); color: var(--fg); }
.jr-tab.is-on { border-color: var(--fg); color: var(--fg); }

/* --- Filter bar ----------------------------------------------------------- */
.jr-filters input { width: 110px; }
.jr-filters input[type="search"] { flex: 1 1 200px; width: auto; min-width: 160px; }

.jr-select { position: relative; display: inline-flex; align-items: center; }
.jr-select select {
  width: 160px;
  height: 32.5px;
  padding: 0 26px 0 10px;
  font-size: 11px;
  color: var(--fg-dim);
  cursor: pointer;
}
.jr-select.is-set select { border-color: var(--fg); color: var(--fg); }
.jr-select .caret { position: absolute; right: 10px; pointer-events: none; }

/* --- Period control ------------------------------------------------------- */
.jr-period { position: relative; display: inline-flex; }
.jr-period > summary.jr-period-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 32.5px;
  padding: 0 11px;
  border: 2px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--fg-dim);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}
.jr-period.is-set > summary.jr-period-btn { border-color: var(--fg); color: var(--fg); }
.jr-period > summary.jr-period-btn:hover { border-color: var(--fg); }

.jr-picker {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 30;
  width: 262px;
  max-width: calc(100vw - 48px);
  padding: 12px;
  border: 2px solid var(--fg);
  border-radius: var(--radius-m);
  background: var(--bg);
  box-shadow: var(--shadow-hard);
  display: flex;
  flex-direction: column;
  gap: 10px;
  animation: row-in 160ms steps(4);
}
.jr-picker-presets { display: flex; align-items: center; gap: 6px; }
.jr-picker-presets .grow { flex: 1; }
.jr-picker .jr-preset, .jr-picker .jr-picker-all {
  padding: 6px 10px;
  border: 2px solid var(--rule);
  border-radius: var(--radius-s);
  background: var(--bg);
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  line-height: 1;
}
.jr-picker .jr-preset:hover, .jr-picker .jr-picker-all:hover { border-color: var(--fg); background: var(--bg); color: var(--fg); }
.jr-picker .jr-preset.is-on { border-color: var(--fg); color: var(--fg); }
.jr-picker .icon { width: 26px; height: 26px; padding: 0; flex: none; }
.jr-picker-ft button, .jr-picker .jr-picker-ft button { padding: 6px 10px; }
.jr-picker-nav { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 2px; border-top: 1px solid var(--rule); }
.jr-picker-month { font-family: var(--font-pixel); font-size: 11px; letter-spacing: var(--track-s); }
.jr-weekdays, .jr-days { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.jr-weekdays {
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--fg-mute);
  text-align: center;
}
.jr-picker .jr-day {
  height: 28px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: var(--radius-s);
  background: var(--bg);
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.jr-picker .jr-day:hover { border-color: var(--line); background: var(--bg); color: var(--fg); }
.jr-picker .jr-day.in-range { background: var(--select-bg); color: var(--fg); }
.jr-picker .jr-day.is-edge { border-color: var(--fg); background: var(--fg); color: var(--bg); }
.jr-picker .jr-day.is-edge:hover { background: var(--white-hover); border-color: var(--white-hover); color: var(--bg); }
.jr-day-blank { height: 28px; }
.jr-picker-ft { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 8px; border-top: 1px solid var(--rule); }

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
/* Only the two counts are right-aligned; First/Last read as timestamps and stay
   left, as in the design — a right-aligned stamp in a wide column floats away
   from the header that names it. */
.jr-row.jr-session > :nth-child(2), .jr-row.jr-session > :nth-child(3) { text-align: right; }
.jr-session-id { font-family: var(--font-pixel); font-size: 11px; letter-spacing: 0.04em; }
.jr-row .jr-skipped { color: var(--fg-mute); }
.jr-row .jr-skipped .skipped { color: var(--fg); font-weight: 700; }

/* Records: Time · Message · State · Lat, optionally led by Session */
.jr-panel .jr-row.jr-record, .jr-panel .jr-row.jr-row-hd:not(.jr-session) {
  grid-template-columns: 150px minmax(0, 1fr) 270px 72px;
}
.jr-panel.jr-with-session .jr-row.jr-record, .jr-panel.jr-with-session .jr-row.jr-row-hd:not(.jr-session) {
  grid-template-columns: minmax(0, 0.8fr) 150px minmax(0, 1.4fr) 270px 72px;
}
.jr-row .jr-lat { text-align: right; }
.jr-row-hd:not(.jr-session) > :nth-last-child(-n + 2) { text-align: right; }
.jr-state { display: inline-flex; gap: 6px; justify-content: flex-end; white-space: nowrap; min-width: 0; overflow: hidden; }
.jr-what .method, .jr-what .tool-name { color: var(--fg); }
.jr-what .server { color: var(--fg-dim); }
.jr-decision > summary .jr-what { font-family: var(--font-pixel); font-size: 11px; letter-spacing: 0.04em; }
.jr-decision > summary .jr-agent { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0; }
.jr-row .session-link { border: none; font-family: var(--font-pixel); font-size: 11px; letter-spacing: 0.04em; }
.jr-row .session-link:hover { text-decoration: underline; }

/* Disclosure body: rule line + payload, indented to the Message column */
details.jr-rec > summary { cursor: pointer; }
details.jr-rec[open] > summary { background: var(--hover-bg); border-bottom-color: var(--hair); }
.jr-rec-bd {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 16px 14px 178px;
  border-bottom: 1px solid var(--hair);
  animation: row-in 180ms steps(4);
}
.jr-with-session .jr-rec-bd { padding-left: 16px; }
.jr-rec-bd .payload { max-height: 320px; }
.jr-rec-bd .rule { color: var(--fg-dim); }

@media (max-width: 980px) {
  .jr-panel .jr-row.jr-record, .jr-panel .jr-row.jr-row-hd:not(.jr-session) {
    grid-template-columns: 150px minmax(0, 1fr) auto 72px;
  }
  .jr-panel.jr-with-session .jr-row.jr-record, .jr-panel.jr-with-session .jr-row.jr-row-hd:not(.jr-session) {
    grid-template-columns: minmax(0, 0.8fr) 150px minmax(0, 1.4fr) auto 72px;
  }
}
@media (max-width: 820px) {
  .jr-row.jr-session { grid-template-columns: minmax(0, 1fr) 70px 80px; }
  .jr-row.jr-session > :nth-child(4), .jr-row.jr-session > :nth-child(5) { display: none; }
  .jr-rec-bd { padding-left: 16px; }
}
`
