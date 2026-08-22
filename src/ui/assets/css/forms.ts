/**
 * Form controls of the McpCut console. Inputs sit on pure black with a 2px
 * grey rule that turns white on focus; labels are the 10px tracked caps of
 * the design; option groups render as pill buttons. Page modules may lay
 * fields out in grids but never restyle the controls themselves.
 */
export const CSS_FORMS = `
input, textarea, select {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--fg);
  background: var(--bg);
  border: 2px solid var(--line);
  border-radius: var(--radius);
  padding: 9px 11px;
  min-width: 0;
  max-width: 100%;
}
input::placeholder, textarea::placeholder { color: var(--fg-faint); }
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--fg); }
input:focus-visible, textarea:focus-visible, select:focus-visible, button:focus-visible, a:focus-visible, summary:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.14);
}
textarea { line-height: 1.6; resize: vertical; }
select { appearance: none; -webkit-appearance: none; padding-right: 28px; }
input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  padding: 0;
  margin: 0;
  border: 2px solid var(--line);
  border-radius: 2px;
  vertical-align: middle;
  cursor: pointer;
}
input[type="checkbox"]:checked { background: var(--fg); border-color: var(--fg); }
input[type="hidden"] { display: none; }

form { display: flex; flex-direction: column; gap: 14px; }
form.stacked { gap: 14px; }
form p { margin: 0; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
label > span:first-child, .field > .label { font-size: 10px; letter-spacing: var(--track); text-transform: uppercase; color: var(--fg-mute); }
label.check { flex-direction: row; align-items: center; gap: 10px; color: var(--fg-dim); cursor: pointer; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-hint { font-size: 11px; color: var(--fg-faint); line-height: 1.5; }
.field-hint.bad { color: var(--fg); }
.field-group {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-m);
}
.form-actions { display: flex; gap: 10px; align-items: center; }
.form-actions .grow { flex: 1; }
.form-actions button[type="submit"] { flex: 1; padding: 12px; font-size: 11px; letter-spacing: var(--track-s); }
.form-actions .btn-secondary, .form-actions button.secondary { flex: none; padding: 12px 16px; }

.choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
.choice {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 9px;
  padding: 10px 11px;
  border: 2px solid var(--rule);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--fg-dim);
  font-size: 12px;
  cursor: pointer;
}
.choice:hover { border-color: var(--line); }
.choice input[type="radio"] { appearance: none; -webkit-appearance: none; width: 12px; height: 12px; margin: 0; padding: 0; border: 2px solid var(--line); border-radius: 0; }
.choice input[type="radio"]:checked { background: var(--fg); border-color: var(--fg); }
.choice:has(input:checked) { border-color: var(--fg); color: var(--fg); }

.filters { display: flex; flex-direction: row; flex-wrap: wrap; gap: 8px; align-items: center; }
.filters input { padding: 7px 10px; font-size: 11px; }
.filters button { padding: 8px 12px; }
`
