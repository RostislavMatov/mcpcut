/**
 * Page-specific layout for `/groups` (M5.5 п.2). Only layout lives here — card
 * internals, matrix columns, the member list and the three overlay drawers;
 * every panel, pill, badge, table and button is the shared component from
 * `components.ts` / `forms.ts`, unchanged.
 *
 * The `details.gr-drawer` selectors are element+class on purpose: the shared
 * `details.drawer` rule in `components.ts` has specificity (0,1,1) and beats a
 * bare `.gr-drawer`, which would leave a CLOSED overlay as a bordered sliver on
 * the page — the same trap the servers drawers document at `page-servers.ts`.
 */
export const CSS_PAGE_GROUPS = `
/* --- Group cards ----------------------------------------------------------- */
.gr-panel .panel-hd .row { gap: 14px; }
.gr-panel .empty { border-style: dashed; }
.gr-list { display: flex; flex-direction: column; }
/* The card zeroes its own padding, so the summary has to supply the inset
   itself — otherwise its name and counter sit flush against the 2px border and
   misalign with the body below (.gr-bd, 14px). Same inset as .srv-sum. */
.gr-card { padding: 0; }
.gr-sum { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 11px 14px; }
.gr-sum .name { font-size: 12px; letter-spacing: var(--track-s); }
.gr-sum .num { margin-left: auto; }
.gr-bd { display: flex; flex-direction: column; gap: 12px; padding: 12px 14px 14px; }
.gr-bd .table-wrap { border-color: var(--hair); }
.gr-matrix th:last-child, .gr-matrix td.gr-ungrant { width: 1%; white-space: nowrap; text-align: right; }
.gr-matrix td.gr-server { font-family: var(--font-pixel); font-size: 11px; letter-spacing: 0.04em; }
.gr-matrix td code { margin: 1px 0; display: inline-block; }

/* --- Members --------------------------------------------------------------- */
.gr-members { display: flex; flex-direction: column; gap: 8px; }
.gr-member-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.gr-member { display: flex; align-items: center; gap: 6px; }
.gr-members .empty { padding: 12px; }
.gr-foot { display: flex; justify-content: flex-end; align-items: center; gap: 10px; }
.gr-holders { margin-top: 4px; }

/* --- Removal interstitial and its refusal twin ------------------------------ */
.gr-confirm .actions { display: flex; gap: 10px; justify-content: flex-end; }
.gr-notice { display: flex; flex-direction: column; gap: 10px; padding: 16px; }
.gr-notice p { font-size: 12px; }

/* --- Overlay drawers (create / grant / join) -------------------------------- */
details.gr-drawer { border: none; border-radius: 0; padding: 0; background: none; overflow: visible; }
details.gr-drawer:not([open]) { display: none; }
.gr-drawer > summary.gr-drawer-sum {
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
.gr-drawer[open] {
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
.gr-modal {
  width: 100%;
  max-width: 520px;
  max-height: 100%;
  overflow-y: auto;
  border: 2px solid var(--fg);
  border-radius: 8px;
  background: var(--bg);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.gr-modal-hd { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.gr-modal-x { text-decoration: none; line-height: 1; }
.gr-form { display: flex; flex-direction: column; gap: 14px; }
.gr-grant-who, .gr-grant-dims { display: grid; gap: 12px; }
.gr-grant-who { grid-template-columns: 1fr 1fr; }
.gr-grant-dims { grid-template-columns: repeat(3, minmax(0, 1fr)); }
@media (max-width: 640px) { .gr-grant-who, .gr-grant-dims { grid-template-columns: 1fr; } }
`
