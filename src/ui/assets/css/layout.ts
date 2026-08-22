/**
 * The page shell: top bar (brand · status · search · whoami · sign-out), the
 * tab navigation, `<main>` and the toast region. Class names are the contract
 * with `pages/layout.ts`; page modules never restyle these.
 */
export const CSS_LAYOUT = `
.topbar {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
  padding-bottom: 14px;
  border-bottom: 2px solid var(--rule);
}
.brand {
  font-family: var(--font-pixel);
  font-size: 20px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--fg);
  border: none;
}
.brand:hover { border: none; }
.status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  letter-spacing: var(--track);
  text-transform: uppercase;
  color: var(--fg-mute);
}
.search {
  flex: 1;
  min-width: 180px;
  max-width: 380px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 2px solid var(--line);
  border-radius: var(--radius-m);
}
.search:focus-within { border-color: var(--fg); }
.search .dot { background: var(--fg-faint); width: 6px; height: 6px; }
.search input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  background: none;
  color: var(--fg);
  font-size: 12px;
  letter-spacing: 0.02em;
}
.search input:focus { outline: none; }
.whoami {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--fg-dim);
}
.whoami .avatar {
  width: 22px;
  height: 22px;
  border: 2px solid var(--fg);
  border-radius: var(--radius-s);
  display: inline-block;
}
.whoami .role { color: var(--fg-mute); }
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
  cursor: pointer;
}
.sign-out button:hover { border-color: var(--fg); }
.spacer { flex: 1; }

.tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border: 2px solid var(--rule);
  border-radius: var(--radius-l);
  background: var(--panel);
}
.tab, .tab-group {
  display: flex;
  align-items: stretch;
  border: 2px solid var(--rule);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg);
}
.tab {
  align-items: center;
  gap: 9px;
  padding: 9px 14px;
  color: var(--fg-dim);
  font-family: var(--font-pixel);
  font-size: 11px;
  letter-spacing: var(--track-s);
  text-transform: uppercase;
}
.tab:hover { border-color: var(--fg); color: var(--fg); }
.tab[aria-current="page"], .tab-group { border-color: var(--fg); color: var(--fg); }
.tab-group .tab {
  border: none;
  border-radius: 0;
  color: var(--fg);
}
.tab-group .tab-plus {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  border: none;
  border-left: 2px solid var(--fg);
  border-radius: 0;
  background: var(--fg);
  color: var(--bg);
  font-family: var(--font-pixel);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.tab-group .tab-plus:hover { background: var(--white-hover); }
.tabs .meta {
  font-size: 11px;
  color: var(--fg-mute);
  font-variant-numeric: tabular-nums;
}

main {
  display: flex;
  flex-direction: column;
  gap: var(--gap-l);
  min-width: 0;
}

.toast-region {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 80;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.toast {
  padding: 11px 12px;
  border: 2px solid var(--fg);
  border-radius: var(--radius);
  background: var(--fg);
  color: var(--bg);
  font-size: 11px;
  line-height: 1.5;
  animation: row-in 180ms steps(4);
}
`
