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
`
