/**
 * `/login` — the Auth screen of the McpCut design: centred column, brand and
 * tagline, the token form on a translucent panel, a status line and a
 * glass footer. The page has no shell (no tabs, no whoami), so `<main>` is
 * the whole viewport here.
 */
export const CSS_PAGE_LOGIN = `
body.page-login { justify-content: center; align-items: center; padding: 48px 24px; }
body.page-login main { width: 100%; max-width: 380px; gap: 28px; }
.login-brand { display: flex; flex-direction: column; align-items: center; gap: 14px; text-align: center; }
.login-brand .brand { font-size: 30px; }
.login-brand .tagline { font-size: 13px; line-height: 1.6; color: var(--fg-dim); max-width: 30ch; text-wrap: pretty; }
.login-form {
  padding: 26px 24px;
  border-radius: 10px;
  background: rgba(10, 10, 10, 0.62);
  backdrop-filter: blur(2px);
}
.login-form form { gap: 18px; }
.login-form label > span:first-child { font-size: 11px; color: var(--fg-dim); }
.login-form input { padding: 12px 14px; border-radius: var(--radius-m); font-size: 14px; letter-spacing: 0.08em; }
.login-form input:focus { box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.14); }
.login-form button[type="submit"] { margin-top: 4px; padding: 14px 18px; border-radius: var(--radius-l); font-size: 13px; letter-spacing: var(--track-s); }
.login-form button[type="submit"]:active { transform: translateY(1px); }
.login-foot { display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; }
.login-foot .hint { border: none; padding: 0; font-size: 12px; color: var(--fg-mute); line-height: 1.6; max-width: 34ch; }
.login-foot .status { font-size: 11px; letter-spacing: var(--track-s); }
.login-foot .status .dot { border-radius: 2px; }
.login-footer {
  width: 100%;
  max-width: 960px;
  margin-top: 48px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(14px);
  padding: 28px 32px;
  display: grid;
  grid-template-columns: 1.4fr 1fr 1fr;
  gap: 32px;
  color: rgba(255, 255, 255, 0.66);
  font-size: 12px;
  line-height: 1.7;
}
.login-footer .col { display: flex; flex-direction: column; gap: 8px; }
.login-footer .brand { font-size: 16px; }
.login-footer .label { color: rgba(255, 255, 255, 0.4); font-size: 11px; }
.login-footer .version { display: flex; align-items: center; gap: 8px; font-size: 11px; letter-spacing: var(--track-s); text-transform: uppercase; color: rgba(255, 255, 255, 0.45); }
.login-footer .version .dot { width: 6px; height: 6px; }
.login-footer a { color: rgba(255, 255, 255, 0.66); border-bottom-color: rgba(255, 255, 255, 0.2); }
.login-footer a:hover { color: var(--fg); }
@media (max-width: 720px) { .login-footer { grid-template-columns: 1fr; } }

/* --- Auth screen controls ------------------------------------------------- */
.login-field-hd { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.login-field-hd .ghost { font-size: 11px; }
.login-remember { flex-direction: row; align-items: center; gap: 10px; font-size: 12px; color: var(--fg-dim); cursor: pointer; position: relative; }
.login-remember input { position: absolute; opacity: 0; width: 18px; height: 18px; margin: 0; }
.login-remember .box {
  width: 18px; height: 18px; flex: none; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 4px; border: 2px solid var(--line); background: var(--bg);
}
.login-remember .box::after { content: ''; width: 6px; height: 6px; border-radius: 1px; background: transparent; }
.login-remember.is-on .box { border-color: var(--fg); background: var(--fg); }
.login-remember.is-on .box::after { background: var(--bg); }
.login-remember input:focus-visible + .box { box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.14); }
.login-form input.is-sent { color: transparent; caret-color: transparent; border-color: transparent; background: transparent; box-shadow: none; animation: login-fade-out 900ms cubic-bezier(.4,0,.6,1) forwards; }
body.page-login { position: relative; overflow-x: hidden; }
/* <main> is static on purpose: the decor layer inside it must size to the BODY. */
body.page-login main { position: static; }
.login-brand, .login-form, .login-foot { position: relative; z-index: 1; }
.login-footer { position: relative; z-index: 2; }
.login-spacer { height: 70vh; flex: none; width: 100%; }

/* --- Decor layer (art, not data) ------------------------------------------- */
@keyframes login-in-left { from { opacity: 0; transform: translateX(-60vw) } 30% { opacity: 1 } to { opacity: 1; transform: none } }
@keyframes login-in-top { from { opacity: 0; transform: translateY(-70vh) } 30% { opacity: 1 } to { opacity: 1; transform: none } }
@keyframes login-in-bottom { from { opacity: 0; transform: translateY(70vh) } 30% { opacity: 1 } to { opacity: 1; transform: none } }
@keyframes login-fill-right { from { width: 0% } to { width: 100% } }
@keyframes login-fade-out { from { opacity: 1 } to { opacity: 0 } }
@keyframes login-dot-pulse { 0%, 100% { opacity: 0.75; transform: scale(0.9) } 50% { opacity: 1; transform: scale(1.15) } }

.login-decor {
  position: absolute; inset: 0; z-index: 0; pointer-events: none; overflow: hidden;
  -webkit-mask-image: linear-gradient(90deg, #000 0, #000 24%, rgba(0,0,0,0.3) 38%, rgba(0,0,0,0.3) 62%, #000 76%, #000 100%);
  mask-image: linear-gradient(90deg, #000 0, #000 24%, rgba(0,0,0,0.3) 38%, rgba(0,0,0,0.3) 62%, #000 76%, #000 100%);
}
.login-decor.is-hidden { visibility: hidden; }
.decor-block {
  position: absolute; left: 194px; width: 30px; height: 56px; overflow: hidden;
  border: 2px solid var(--fg); border-radius: 2px; background: var(--bg); opacity: 0;
}
.decor-block:nth-child(1) { top: 44px; }
.decor-block:nth-child(2) { top: 120px; }
.decor-block:nth-child(3) { top: 196px; }
.decor-block:nth-child(4) { top: 272px; }
.decor-block:nth-child(5) { top: 348px; }
.decor-block:nth-child(6) { top: 424px; }
.decor-target {
  position: absolute; right: 24px; top: 235px; width: 200px; height: 96px; overflow: hidden; z-index: 3;
  border: 2px solid var(--fg); border-radius: 2px; background: var(--bg); opacity: 0;
  transition: opacity 900ms cubic-bezier(.4,0,.6,1);
}
.decor-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0%; background: var(--fg); overflow: hidden; pointer-events: none; z-index: 4; }
.decor-fill-anim { animation-name: login-fill-right; animation-timing-function: steps(7); animation-fill-mode: forwards; }
.decor-fill-tgt { transition: width 620ms cubic-bezier(.22,.7,.2,1), opacity 240ms linear; }
.decor-fill-slow { transition: width 760ms cubic-bezier(.22,.7,.2,1); }
.decor-fill-field { border-radius: 6px; transition: width 700ms cubic-bezier(.22,.7,.2,1); }
.decor-stripes { position: absolute; inset: 0; background-image: repeating-linear-gradient(90deg, #000 0 2px, transparent 2px 4px); transition: opacity 400ms steps(4); }
.decor-erase { position: absolute; inset: 0; left: 0; width: 0%; background: var(--bg); transition: width 700ms cubic-bezier(.22,.7,.2,1); }
.decor-wipe { position: absolute; left: 0; top: 0; bottom: 0; width: 0%; background: var(--bg); transition: width 700ms cubic-bezier(.22,.7,.2,1); }
.decor-seg { position: absolute; background: var(--fg); }
.decor-seg-h { height: 2px; width: 0; transition: width 700ms cubic-bezier(.22,.7,.2,1); }
.decor-seg-v { width: 2px; height: 0; transition: height 600ms cubic-bezier(.22,.7,.2,1); }
.decor-seg-fast.decor-seg-h { transition: width 520ms linear; }
.decor-seg-fast.decor-seg-v { transition: height 420ms linear; }
.decor-dot { position: absolute; width: 6px; height: 6px; border-radius: 50%; background: var(--fg); transition: left 700ms linear; }
.decor-glow {
  position: absolute; left: -37px; top: -37px; width: 80px; height: 80px; border-radius: 50%; pointer-events: none;
  background: radial-gradient(circle, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0.22) 26%, rgba(255,255,255,0.07) 52%, rgba(255,255,255,0) 74%);
  filter: blur(7px); animation: login-dot-pulse 1600ms ease-in-out infinite;
}
.decor-recs {
  position: absolute; inset: 0; display: flex; align-items: center; padding: 0 12px; z-index: 2;
  font-size: 12px; line-height: 1; letter-spacing: 0.02em; font-variant-numeric: tabular-nums; color: rgba(255,255,255,0.92);
  transition: opacity 240ms linear;
}
.decor-clip { width: 0%; overflow: hidden; transition: width 520ms steps(20); }
.decor-textrow { position: absolute; inset: 0; display: flex; align-items: center; padding: 0 12px; overflow: hidden; opacity: 0; transition: opacity 200ms linear; }
.decor-textrow-inner { display: flex; align-items: center; gap: 14px; width: 100%; white-space: nowrap; overflow: hidden; font-size: 12px; line-height: 1; letter-spacing: 0.02em; font-variant-numeric: tabular-nums; color: rgba(255,255,255,0.92); }
.decor-t-dim { color: rgba(255,255,255,0.55); }
.decor-t-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.decor-t-status { letter-spacing: 0.12em; min-width: 62px; text-align: right; }
.decor-ghost {
  position: absolute; border: 2px solid var(--fg); border-radius: 2px; background: var(--bg); overflow: hidden;
  display: flex; align-items: center; z-index: 4;
  transition: top 560ms cubic-bezier(.3,.8,.3,1), height 560ms cubic-bezier(.3,.8,.3,1);
}
.decor-ghost .decor-textrow { position: relative; inset: auto; width: 100%; }
.decor-tabs { position: absolute; right: 24px; width: 200px; display: flex; flex-direction: column; gap: 6px; }
.decor-tab {
  position: relative; height: 22px; margin-top: -28px; overflow: hidden; border: 2px solid var(--fg); border-radius: 2px; background: var(--bg);
  opacity: 0; transform: translateY(-24px) scaleY(0.5); transform-origin: top;
  transition: opacity 300ms linear, transform 620ms cubic-bezier(.34,1.32,.5,1), margin-top 620ms cubic-bezier(.34,1.32,.5,1), filter 600ms linear;
}
.decor-tab.is-in { opacity: 1; transform: none; margin-top: 0; }
.decor-bars { position: absolute; inset: 0; display: flex; align-items: center; gap: 6px; padding: 0 7px; transition: opacity 200ms linear; }
.decor-knob { width: 6px; height: 6px; flex: none; background: var(--fg); }
.decor-bar { flex: 1; height: 2px; background: rgba(255,255,255,0.5); }
.decor-bar2 { width: 14px; height: 2px; flex: none; background: rgba(255,255,255,0.5); }
.decor-slot { flex: none; height: 0; transition: height 560ms cubic-bezier(.3,.8,.3,1), margin-bottom 560ms cubic-bezier(.3,.8,.3,1); }
.login-sheet {
  position: fixed; background: var(--fg); border-radius: 2px; z-index: 50;
  transition: left 900ms cubic-bezier(.5,0,.3,1), top 900ms cubic-bezier(.5,0,.3,1), width 900ms cubic-bezier(.5,0,.3,1), height 900ms cubic-bezier(.5,0,.3,1), border-radius 900ms linear;
}
@media (max-width: 900px) { .login-decor { visibility: hidden; } }
`
