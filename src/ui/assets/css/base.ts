/**
 * Design tokens, resets, typography and motion for the McpCut console
 * (Claude Design project, 2026-08-22). This is the FIRST CSS module in the
 * concatenation order (`app-css.ts`), so everything later may rely on the
 * custom properties declared here.
 *
 * The language: pure black ground with a faint 4px scanline, white 2px rules,
 * a pixel display face (Silkscreen, embedded — see `fonts.ts`) for brand,
 * headings and navigation, a monospace face for everything else, and
 * step-timed motion. No colour besides white and greys: status is carried by
 * weight, border and animation, never by hue alone.
 *
 * Self-contained by CSP: `@font-face` points at same-origin `/assets/*`, and
 * there is no `@import` and no external URL anywhere in the sheet
 * (`tests/ui/html.test.ts` pins both).
 */
export const CSS_BASE = `
@font-face {
  font-family: 'Silkscreen';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(/assets/silkscreen-400.woff2) format('woff2');
}
@font-face {
  font-family: 'Silkscreen';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url(/assets/silkscreen-700.woff2) format('woff2');
}

:root {
  color-scheme: dark;
  --bg: #000000;
  --fg: #FFFFFF;
  --fg-dim: #A8A8A8;
  --fg-mute: #6E6E6E;
  --fg-faint: #5A5A5A;
  --line: #3A3A3A;
  --rule: #1F1F1F;
  --hair: #141414;
  --panel: rgba(10, 10, 10, 0.6);
  --hover-bg: rgba(255, 255, 255, 0.04);
  --select-bg: rgba(255, 255, 255, 0.08);
  --white-hover: #E4E4E4;
  --shadow-hard: 12px 12px 0 rgba(255, 255, 255, 0.12);
  --font-pixel: 'Silkscreen', ui-monospace, monospace;
  --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --radius-s: 4px;
  --radius: 5px;
  --radius-m: 6px;
  --radius-l: 8px;
  --gap: 12px;
  --gap-l: 16px;
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
  font-size: 12px;
  line-height: 1.5;
  padding: 20px 24px 40px;
  display: flex;
  flex-direction: column;
  gap: var(--gap-l);
}

a {
  color: var(--fg);
  text-decoration: none;
  border-bottom: 1px solid rgba(255, 255, 255, 0.4);
}
a:hover { border-bottom-color: var(--fg); }

h1, h2, h3, h4 {
  margin: 0;
  font-family: var(--font-pixel);
  font-weight: 400;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  line-height: 1.25;
}
h1 { font-size: 13px; }
h2 { font-size: 12px; }
h3 { font-size: 11px; letter-spacing: var(--track-s); }
h4 { font-size: 10px; letter-spacing: var(--track); color: var(--fg-mute); }

p { margin: 0; }
ul, ol { margin: 0; padding: 0; list-style: none; }

code, pre, kbd {
  font-family: var(--font-mono);
  font-size: 12px;
}
code {
  padding: 1px 6px;
  border: 1px dashed var(--line);
  border-radius: var(--radius-s);
  overflow-wrap: anywhere;
}
pre {
  margin: 0;
  padding: 11px 12px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  color: var(--fg-dim);
  font-size: 11px;
  line-height: 1.6;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

::selection { background: var(--fg); color: var(--bg); }
[hidden] { display: none !important; }

.scroll, .scroll-y {
  scrollbar-width: thin;
  scrollbar-color: var(--fg) var(--hair);
}
.scroll::-webkit-scrollbar, .scroll-y::-webkit-scrollbar { width: 10px; height: 10px; }
.scroll::-webkit-scrollbar-track, .scroll-y::-webkit-scrollbar-track { background: var(--hair); border-left: 1px solid var(--rule); }
.scroll::-webkit-scrollbar-thumb, .scroll-y::-webkit-scrollbar-thumb { background: var(--fg); border: 2px solid var(--hair); }

@keyframes blink { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }
@keyframes row-in { from { opacity: 0; transform: translateY(-8px) } to { opacity: 1; transform: none } }
@keyframes pixel-shimmer {
  0%   { color: var(--fg-mute); text-shadow: none }
  25%  { color: var(--fg-dim); text-shadow: 1px 0 0 rgba(255,255,255,0.35) }
  50%  { color: var(--fg); text-shadow: 0 1px 0 rgba(255,255,255,0.6) }
  75%  { color: var(--fg-dim); text-shadow: -1px 0 0 rgba(255,255,255,0.35) }
  100% { color: var(--fg-mute); text-shadow: none }
}

.blink { animation: blink 1.2s steps(1) infinite; }
.row-in { animation: row-in 320ms steps(4); }
.shimmer { animation: pixel-shimmer 1.6s steps(4, end) infinite; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`
