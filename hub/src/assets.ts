import { buildAsset, type Asset } from '../../src/ui/assets/asset.js'
import { FAVICON } from '../../src/ui/assets/favicon.js'
import { SILKSCREEN_400, SILKSCREEN_700 } from '../../src/ui/assets/fonts.js'

/**
 * The hub's static assets, inlined as a TypeScript module rather than read
 * from disk at runtime — the hub must not depend on the `site/` directory's
 * layout at runtime (plan Task 4), and `tsc` does not copy non-`.ts` files
 * into `dist/` anyway (the same reasoning as `src/ui/assets/asset.ts`).
 *
 * `HUB_CSS` deliberately duplicates the design tokens and base rules of
 * `site/site.css` (the plan calls this out explicitly: "hub.css = site/
 * site.css + forms/buttons") rather than importing or reading that file, so
 * hub pages look like the same product's preview page and admin console
 * (black ground, white 2px rules, Silkscreen for brand/headings, a
 * monospace body face) without pulling `site/` into the hub's runtime
 * dependency graph. The forms, buttons, panels and notices are new — the
 * preview page has none — patterned after the admin console's own component
 * language so a visitor moving from the console to the hub sees one product.
 *
 * Served under the hub's own CSP (`default-src 'none'` with a per-directive
 * `'self'` allowlist, mirroring `src/ui/security-headers.ts`): no `@import`,
 * no external URL, fonts loaded from this same asset table.
 */
const HUB_CSS = `
@font-face {
  font-family: 'Silkscreen';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(/hub-assets/silkscreen-400.woff2) format('woff2');
}
@font-face {
  font-family: 'Silkscreen';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url(/hub-assets/silkscreen-700.woff2) format('woff2');
}

:root {
  color-scheme: dark;
  --bg: #000000;
  --fg: #FFFFFF;
  --fg-dim: #B4B4B4;
  --fg-mute: #8A8A8A;
  --fg-faint: #5A5A5A;
  --line: #3A3A3A;
  --rule: #1F1F1F;
  --hair: #141414;
  --panel: rgba(10, 10, 10, 0.72);
  --hover-bg: rgba(255, 255, 255, 0.06);
  --white-hover: #E4E4E4;
  --shadow-hard: 12px 12px 0 rgba(255, 255, 255, 0.12);
  --font-pixel: 'Silkscreen', ui-monospace, monospace;
  --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --radius-s: 4px;
  --radius: 6px;
  --radius-m: 6px;
  --radius-l: 8px;
  --gutter: 24px;
  --gap: 14px;
  --measure: 720px;
  --track: 0.14em;
  --track-s: 0.08em;
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }

body {
  min-height: 100vh;
  background: var(--bg);
  background-image: linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px);
  background-size: 100% 4px;
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: 14px;
  line-height: 1.65;
  padding: 20px var(--gutter) 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--gap);
}
body > * { width: 100%; max-width: var(--measure); }

a { color: var(--fg); text-decoration: none; border-bottom: 1px solid rgba(255, 255, 255, 0.4); }
a:hover { border-bottom-color: var(--fg); }
a:focus-visible, button:focus-visible, input:focus-visible {
  outline: 2px dashed var(--fg);
  outline-offset: 3px;
}

h1, h2, h3 {
  margin: 0;
  font-family: var(--font-pixel);
  font-weight: 400;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  line-height: 1.25;
}
h1 { font-size: 18px; }
h2 { font-size: 13px; color: var(--fg-dim); }
p { margin: 0; }
ul.list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
ul.list li { position: relative; padding-left: 16px; color: var(--fg-dim); }
ul.list li::before { content: ''; position: absolute; left: 0; top: 0.6em; width: 6px; height: 6px; background: var(--fg); }

code, pre {
  font-family: var(--font-mono);
  font-size: 13px;
}
code { padding: 1px 6px; border: 1px dashed var(--line); border-radius: 4px; overflow-wrap: anywhere; }
pre {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: #050505;
  color: var(--fg);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow-x: auto;
}

::selection { background: var(--fg); color: var(--bg); }

/* --- Top bar & nav (signed-in shell) --------------------------------------- */
.topbar {
  display: flex;
  align-items: center;
  gap: var(--gap);
  flex-wrap: wrap;
  padding-bottom: 14px;
  border-bottom: 2px solid var(--rule);
}
.brand {
  font-family: var(--font-pixel);
  font-weight: 700;
  font-size: 18px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border-bottom: 0;
}
.tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.tab {
  display: inline-block;
  padding: 7px 14px;
  border: 2px solid var(--line);
  border-radius: var(--radius);
  font-family: var(--font-pixel);
  font-size: 11px;
  letter-spacing: var(--track-s);
  text-transform: uppercase;
  color: var(--fg-dim);
}
.tab:hover { border-color: var(--fg); color: var(--fg); }
.tab[aria-current="page"] { border-color: var(--fg); color: var(--fg); }
.spacer { flex: 1; }
.sign-out { margin: 0; }
.sign-out button {
  padding: 7px 12px;
  border: 2px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.sign-out button:hover { border-color: var(--fg); }

.hub-foot { padding-top: 8px; }
.hub-foot nav { font-size: 12px; color: var(--fg-mute); display: flex; gap: 6px; flex-wrap: wrap; }
.hub-foot a { color: var(--fg-dim); }

main { display: flex; flex-direction: column; gap: var(--gap); }

/* --- Panels ----------------------------------------------------------------- */
.panel {
  background: var(--panel);
  border: 2px solid var(--line);
  border-radius: var(--radius-l);
}
.panel-strong { border-color: var(--fg); box-shadow: var(--shadow-hard); }
.panel-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 14px 18px;
  border-bottom: 2px solid var(--rule);
}
.panel-bd { padding: 18px; display: flex; flex-direction: column; gap: 12px; }
.hub-notice { text-align: left; }
.hub-danger { border-color: var(--fg); }

/* --- Callouts, hints, errors ------------------------------------------------ */
.callout {
  padding: 12px;
  border: 2px solid var(--fg);
  border-radius: var(--radius-m);
  font-size: 13px;
  line-height: 1.6;
}
.hint, .field-hint { color: var(--fg-mute); font-size: 12px; line-height: 1.6; }
.error {
  padding: 11px 12px;
  border: 2px solid var(--fg);
  border-radius: var(--radius);
  color: var(--fg);
  font-size: 12px;
}

/* --- Pills ------------------------------------------------------------------ */
.pill {
  display: inline-block;
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-s);
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--fg-dim);
}
.pill-on { border-color: var(--fg); color: var(--fg); }

/* --- Token reveal ------------------------------------------------------------ */
.token {
  padding: 14px;
  border: 2px solid var(--fg);
  border-radius: var(--radius-m);
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
  letter-spacing: 0.02em;
  word-break: break-all;
  user-select: all;
}

/* --- Forms & buttons --------------------------------------------------------- */
form { display: flex; flex-direction: column; gap: 14px; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
label > span:first-child { font-size: 11px; color: var(--fg-mute); }
input {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--fg);
  background: var(--bg);
  border: 2px solid var(--line);
  border-radius: var(--radius);
  padding: 10px 12px;
}
input::placeholder { color: var(--fg-faint); }
input:focus { outline: none; border-color: var(--fg); }
input[type="hidden"] { display: none; }

button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 16px;
  border: 2px solid var(--fg);
  border-radius: var(--radius);
  background: var(--fg);
  color: var(--bg);
  font-family: var(--font-pixel);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
}
button:hover { background: var(--white-hover); border-color: var(--white-hover); }
button.secondary {
  border-color: var(--line);
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-mono);
  letter-spacing: 0.12em;
}
button.secondary:hover { border-color: var(--fg); background: var(--bg); }
button.danger { border-style: dashed; border-color: var(--fg-dim); background: var(--bg); color: var(--fg); }
button.danger:hover { border-style: solid; border-color: var(--fg); }

@media (max-width: 640px) {
  :root { --gutter: 16px; --gap: 10px; }
  body { font-size: 13px; }
  .panel-hd, .panel-bd { padding: 14px; }
}
`

/** The hub's Content-Type for its own stylesheet. */
const CSS_CONTENT_TYPE = 'text/css; charset=utf-8'

/**
 * Every asset the hub serves at `GET /hub-assets/*`, keyed by the path
 * segment after the prefix (e.g. `hub.css` → `/hub-assets/hub.css`). The
 * route handler (Task 5, `hub/src/server.ts`) is the only consumer; this
 * module has no IO of its own.
 */
export const HUB_ASSETS: Readonly<Record<string, Asset>> = Object.freeze({
  'hub.css': buildAsset(HUB_CSS, CSS_CONTENT_TYPE),
  'silkscreen-400.woff2': SILKSCREEN_400,
  'silkscreen-700.woff2': SILKSCREEN_700,
  'favicon.svg': FAVICON,
})
