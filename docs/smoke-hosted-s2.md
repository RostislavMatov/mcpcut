# Live smoke — hosted mcpcut on S2 (2026-09-27)

Phase 5 of PRD `hosted-accounts` (ADR-0017). The stack from `docs/deploy/site/` on the shared VPS behind
Cloudflare (`mcpcut.com`, `*.mcpcut.com`, `mcp.mcpcut.com` all proxied; Origin Rule to `:8443`; Origin CA on
`mcpcut.com, *.mcpcut.com`). The hub itself is not deployed yet (waits for the GitHub OAuth App): tenant installs
were created with the provisioner's operator commands (`provision-create|status|remove`).

## What the smoke found and fixed on the way
1. `Dockerfile` tenant stage — `RUN chmod` after `USER node` failed the first real build → `COPY --chmod=755`
   (`3ef6e32`).
2. `status` read a UI with no owner (303 to `/setup`) as not answering → the probe accepts exactly that redirect
   (`bb496b5`).
3. The provisioner's readiness called the whole CLI (`status --json`): ~7.3 s under the container's 0.25 CPU,
   past its exec timeout, so no install ever read ready → a fixed `node -e` probe (TCP to serve, `GET /login` to
   ui), wider timeouts now that creation runs in the background (`59ee4b0`).

## Results (after the fixes)
| Check | Result |
|---|---|
| `provision-create smoke1` | ok in 40 s, owner token issued (kept on the host, never printed) |
| container limits | Memory 256 MiB = swap, 0.25 CPU, pids 128, read-only root, CapDrop ALL, init, user `node`, no ports |
| idle memory | ~75 MiB and 26 pids per install |
| `https://smoke1.mcpcut.com/login` via Cloudflare | 200 |
| `https://smoke1.mcpcut.com/mcp` without a token | 401 |
| owner token → own install `/api/console/whoami` | 200 |
| same token → another install | 401 |
| from `smoke2`: `mcpcut-t-smoke1`, `hub`, `provisioner`, the owner's `ui` | not resolvable (ENOTFOUND) |
| from `smoke2`: Caddy `:8443` | reachable (shared by design) |
| from `smoke2`: the host's gateway `:22`, `:443` | **reachable** — see below |
| `provision-status smoke1` | running, volume 161 KB |
| owner-token rotation | old token 401, new 200 |
| `provision-remove` ×2 | no container, volume or network left; Caddy back on its own network only |
| unknown subdomain | 502 |
| `mcpcut.com`, `www` (301), `mcp.mcpcut.com/mcp` (401) via Cloudflare | as expected |

## Second pass (2026-09-28), after the isolation and policy fixes
| Check | Result |
|---|---|
| tenant bridge interface | `mct930706cd5cc1` (predictable `mct` prefix) |
| starter policy in a new install | `policy.json` 0600, `require-approval` by default, reads allowed |
| from a tenant: host gateway `:22`, `:443`, host public IP `:22` | blocked (host firewall `mcpcut-tenant-firewall.service`) |
| from a tenant: `1.1.1.1:443` | reachable (the internet stays open) |
| from a tenant: other tenants, hub, provisioner | not resolvable |
| remote console over Cloudflare: `server add` (DeepWiki), `quarantine approve --all`, `agent create`, `agent grant`, `policy set … require-approval` | all exit 0 |
| agent over Cloudflare: `initialize`, `tools/list` | 200; `dw__ask_wiki_question`, `dw__read_wiki_contents`, `dw__read_wiki_structure` |
| gated call with no decision | held **60 s**, answered `-32002` (approval timed out) — Cloudflare did not cut the response |
| gated call approved while waiting | not shown: the smoke script approved the first (already timed-out) request's id; covered by the local e2e tests |

## Open
- ~~The host is reachable from a tenant network~~ — closed 2026-09-28 (`05eeede` + the host unit).
- ~~Waiting 60 s on an approval through Cloudflare~~ — passed 2026-09-28.
- Cloudflare Authenticated Origin Pulls — not enabled yet (matters once the hub is up: its per-IP sign-up limit
  trusts `CF-Connecting-IP`).
- The hub: waits for the GitHub OAuth App.
