/**
 * Shared components of the McpCut console: panels and cards, pills and dots,
 * buttons, tables, callouts, disclosure panels, tiles. Page modules compose
 * these and add only page-specific layout in their own CSS module.
 */
export const CSS_COMPONENTS = `
/* --- Panels & cards ----------------------------------------------------- */
.panel {
  border: 2px solid var(--rule);
  border-radius: var(--radius-l);
  background: var(--panel);
  overflow: hidden;
  min-width: 0;
}
.panel-strong { border-color: var(--fg); }
.panel-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap);
  flex-wrap: wrap;
  padding: 12px 16px;
  border-bottom: 2px solid var(--rule);
}
.panel-hd h1, .panel-hd h2 { font-size: 13px; }
.panel-bd { padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }
.panel-ft {
  padding: 11px 16px;
  border-top: 2px solid var(--rule);
  display: flex;
  justify-content: space-between;
  gap: var(--gap);
  font-size: 11px;
  color: var(--fg-mute);
}
.card {
  border: 2px solid var(--rule);
  border-radius: var(--radius-l);
  background: var(--panel);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.card-strong { border-color: var(--fg); }
.card-hd {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.card-hd .name {
  font-family: var(--font-pixel);
  font-size: 13px;
  letter-spacing: 0.04em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.grid { display: grid; gap: var(--gap); }
.grid-cards { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
.grid-2 { grid-template-columns: 1fr 1fr; }
.stack { display: flex; flex-direction: column; gap: 14px; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.row-between { justify-content: space-between; }
.between { display: flex; justify-content: space-between; gap: var(--gap); align-items: baseline; }

/* --- Labels, pills, dots -------------------------------------------------- */
.label {
  font-size: 10px;
  letter-spacing: var(--track);
  text-transform: uppercase;
  color: var(--fg-mute);
}
.muted { color: var(--fg-mute); }
/* Visually hidden but read aloud: a heading the design draws as something else
   (tabs, a meta line) still has to exist for the document outline. */
.vh {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: 0;
  border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.dim { color: var(--fg-dim); }
.faint { color: var(--fg-faint); }
.small { font-size: 11px; }
.num { font-variant-numeric: tabular-nums; }
.pixel { font-family: var(--font-pixel); letter-spacing: 0.04em; }
.upper { text-transform: uppercase; letter-spacing: 0.12em; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.pretty { text-wrap: pretty; line-height: 1.6; }

.pill, .badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-s);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--fg-dim);
  white-space: nowrap;
  vertical-align: middle;
}
.pill-pixel { font-family: var(--font-pixel); font-size: 9px; letter-spacing: var(--track-s); }
.pill-on { border-color: var(--fg); color: var(--fg); }
.pill-solid, .badge.vault {
  border: 2px solid var(--fg);
  background: var(--fg);
  color: var(--bg);
  font-family: var(--font-pixel);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: none;
  padding: 4px 8px;
}
.pill-solid .dot, .badge.vault .dot { background: var(--bg); }
.badge.write, .badge.destructive, .pill-alert { border-color: var(--fg); color: var(--fg); }
.badge.read { color: var(--fg-dim); }
.badge.revoked { text-decoration: line-through; color: var(--fg-faint); }

.dot {
  width: 8px;
  height: 8px;
  flex: none;
  display: inline-block;
  background: var(--fg);
}
.dot-s { width: 6px; height: 6px; }
.dot-off { background: var(--fg-faint); }
/* Neutral "never checked" state: an outline, neither white (alive) nor gray (down). */
.dot-hollow { background: transparent; border: 1px solid var(--fg-dim); }
.dot-blink { animation: blink 1s steps(1) infinite; }

/* --- Buttons -------------------------------------------------------------- */
button, .btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 9px 14px;
  border: 2px solid var(--fg);
  border-radius: var(--radius);
  background: var(--fg);
  color: var(--bg);
  font-family: var(--font-pixel);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  line-height: 1;
  cursor: pointer;
}
button:hover, .btn:hover { background: var(--white-hover); border-color: var(--white-hover); }
button.secondary, .btn-secondary, button.danger, .btn-danger {
  border-color: var(--line);
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-mono);
  letter-spacing: 0.12em;
}
button.secondary:hover, .btn-secondary:hover { border-color: var(--fg); background: var(--bg); }
button.danger, .btn-danger { border-style: dashed; border-color: var(--fg-dim); }
button.danger:hover, .btn-danger:hover { border-style: solid; border-color: var(--fg); background: var(--bg); }
button.ghost, .btn-ghost {
  padding: 0;
  border: none;
  background: none;
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.1em;
  border-bottom: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 0;
}
button.ghost:hover, .btn-ghost:hover { background: none; border-bottom-color: var(--fg); }
button.icon, .btn-icon {
  width: 26px;
  height: 26px;
  padding: 0;
  flex: none;
  border: 2px solid var(--line);
  border-radius: var(--radius-s);
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: 12px;
}
button.icon:hover, .btn-icon:hover { border-color: var(--fg); background: var(--bg); }
button[disabled], .btn[aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.actions form { margin: 0; }
form.inline { display: inline-flex; flex-direction: row; gap: 6px; align-items: center; margin: 0; }

/* --- Tables --------------------------------------------------------------- */
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
thead th {
  text-align: left;
  padding: 9px 12px;
  border-bottom: 2px solid var(--rule);
  font-size: 10px;
  font-weight: 400;
  letter-spacing: var(--track);
  text-transform: uppercase;
  color: var(--fg-mute);
}
tbody td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--hair);
  vertical-align: top;
}
tbody tr:hover { background: var(--hover-bg); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.table-wrap { overflow-x: auto; border: 1px solid var(--rule); border-radius: var(--radius); }

/* --- Lists of rows (bordered) ---------------------------------------------- */
.rows { border: 1px solid var(--rule); border-radius: var(--radius); overflow: hidden; }
.rows > * { padding: 9px 11px; border-bottom: 1px solid var(--hair); }
.rows > *:last-child { border-bottom: none; }
.rows .empty { color: var(--fg-mute); font-size: 11px; }
.kv {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
  gap: 12px;
  align-items: center;
}
.kv .k { color: var(--fg-dim); word-break: break-all; }

/* --- Callouts, notices, empty states -------------------------------------- */
.callout {
  display: flex;
  gap: 10px;
  padding: 12px;
  border: 2px solid var(--fg);
  border-radius: var(--radius-m);
  font-size: 11px;
  line-height: 1.6;
  text-wrap: pretty;
}
.callout::before { content: ''; width: 8px; flex: none; background: var(--fg); }
.callout code { border-color: var(--fg); }
.notice, .empty, .scan-notice, .hint {
  padding: 11px 12px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  font-size: 11px;
  line-height: 1.6;
  color: var(--fg-mute);
}
.notice.truncated, .notice.error, .error, .warning {
  border: 2px solid var(--fg);
  color: var(--fg);
}
.notice.ok { border-color: var(--fg); color: var(--fg); }
.empty { padding: 26px 16px; font-size: 12px; }
[role="alert"] {
  padding: 11px 12px;
  border: 2px solid var(--fg);
  border-radius: var(--radius);
  font-size: 11px;
  line-height: 1.6;
}
.token {
  padding: 14px;
  border: 2px solid var(--fg);
  border-radius: var(--radius-m);
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
  letter-spacing: 0.04em;
  word-break: break-all;
  user-select: all;
}
.skipped { color: var(--fg); }

/* --- Disclosure panels (no-JS expand/collapse) ----------------------------- */
details > summary { list-style: none; cursor: pointer; }
details > summary::-webkit-details-marker { display: none; }
details.disclosure > summary:hover { background: var(--hover-bg); }
details.drawer {
  border: 2px solid var(--fg);
  border-radius: var(--radius-l);
  background: var(--bg);
  overflow: hidden;
}
details.drawer[open] { box-shadow: var(--shadow-hard); }
details.drawer > summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap);
  padding: 12px 14px;
  font-family: var(--font-pixel);
  font-size: 12px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
details.drawer[open] > summary { border-bottom: 2px solid var(--rule); }
details.drawer > summary::after { content: '+'; font-size: 14px; color: var(--fg-dim); }
details.drawer[open] > summary::after { content: '×'; }
details.drawer > .drawer-bd { padding: 14px; display: flex; flex-direction: column; gap: 14px; animation: row-in 180ms steps(4); }
.caret { flex: none; font-size: 9px; color: var(--fg-dim); }
details[open] > summary .caret { transform: scaleY(-1); }

/* --- Tiles --------------------------------------------------------------- */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--gap); }
.tile {
  border: 2px solid var(--rule);
  border-radius: var(--radius-l);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--panel);
}
.tile-strong { border-color: var(--fg); }
.tile-row { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--gap); }
.tile-value { font-family: var(--font-pixel); font-size: 26px; line-height: 1; }
.tile-unit { font-size: 11px; color: var(--fg-dim); }
.tile-bars {
  height: 26px;
  background:
    repeating-linear-gradient(90deg, rgba(255,255,255,0.3) 0 5px, transparent 5px 7px);
  -webkit-mask-image: linear-gradient(180deg, transparent 0 30%, #000 30% 100%);
  mask-image: linear-gradient(180deg, transparent 0 30%, #000 30% 100%);
}
.tile-strong .tile-bars { background: repeating-linear-gradient(90deg, var(--fg) 0 5px, transparent 5px 7px); }
.tile a { border: none; }

/* --- Pager ---------------------------------------------------------------- */
.pager { display: flex; align-items: center; gap: var(--gap); font-size: 11px; color: var(--fg-mute); }
.pager a, .pager span { padding: 6px 10px; border: 2px solid var(--rule); border-radius: var(--radius-s); border-bottom: 2px solid var(--rule); }
.pager a { color: var(--fg); }
.pager a:hover { border-color: var(--fg); }
.pager .disabled { opacity: 0.5; }
.pager .page { border: none; padding: 0; }
`
