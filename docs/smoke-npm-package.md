# Smoke: the npm package on a clean machine (PRD pool phase 6, before publication)

Date: 2026-09-24. Tarball `mcpcut-0.1.0.tgz` packed from the public export (`~/mcpcut-public`,
`main` = `e3a1dca`): 497 files, 936 898 bytes, sha256 `fd28036aa6c4fab836414ea715dd1d53ffbf37385553f9e8357102f420165553`.
Every path is on the allowlist of `package.json` `files`; every `dist/*.js` has its `src/*.ts`.

**Stand.** A shared VPS (`<S2>`, 2 CPU, ~3.9 GB RAM), Docker only, nothing installed on the host,
no port published. Containers `node:24-bookworm-slim` and `node:22-bookworm-slim` with an empty
`HOME` and their own `npm_config_cache`, on a private Docker network; the reruns were capped at
`--cpus 1 --memory 1g`. Inspector CLI `@modelcontextprotocol/inspector@2.7.0`, servers
`@modelcontextprotocol/server-everything@2026.8.31` and `…/server-filesystem@2026.8.31`. Tokens lived
only in `0600` files on the host and were removed with the stand.

**Stand-in for the registry name.** Before publication `mcpcut@0.1.0` cannot be resolved, so the tarball
stood in for it as `npx -y -p /pkg/mcpcut-0.1.0.tgz mcpcut`. (`npx -y /pkg/mcpcut-0.1.0.tgz` does not
work: npx runs a bare path as a command — the first run of the smoke failed on exactly that, exit 126.)

## A. Before publication

| # | Step | Expected | Result |
|---|---|---|---|
| A1 | empty machine: `npx -y -p <tarball> mcpcut --help` | exit 0, usage on stdout, stderr empty | ✅ exit 0, 146 lines, stderr 0 bytes, 7 s with a cold cache |
| A2 | service from the package: `npm i -g <tarball>`, `setup --yes --no-admin --serve-host 0.0.0.0 --serve-public-url http://svc:8090`, first owner, `server add everything` (stdio, installed binary), `agent create smoke-npm`, `agent grant`, `start serve` | block in the npx form, `--allow-http` last, token in `token:` and `env` only | ✅ probe `alive — 788ms via initialize`; block `"command": "npx"`, `"-y", "mcpcut@0.1.0", "connect", "--url", "http://svc:8090", "--allow-http"`; the token appears exactly twice in the output; `serve` running, with the loud warning about `0.0.0.0` |
| A3 | agent on another machine: the pasted block (tarball standing in for the name), Inspector `tools/list`, `tools/call everything__echo` | prefixed tools; the call returns | ✅ 13 tools `everything__*`; `Echo: npm-smoke`; 65 s from a cold cache (Inspector + mcpcut) |
| A4 | clean stdout: cold cache, one `initialize` on the bridge's stdin | first byte `{`, every stdout line JSON, no token anywhere | ✅ exit 0, first byte `{`, 1 line of 1 is JSON, 0 tokens in stdout and stderr |
| A5 | Node 22: `npx … mcpcut --help` | one line about the floor, exit 1 | ✅ `mcpcut needs Node 24 or newer (this is v22.23.3). Install a current Node and run the command again.`, exit 1, stdout empty |
| A5b | Node 22: `npx -y -p node@24 -p <tarball> mcpcut --help` | works or not — README follows the fact | ✅ exit 0, usage. **Not** put in the Quick start: see finding 2 |
| A6 | Docker image built from the public tree | `--help` exit 0, font licence present | ✅ build 0, `--help` 0, `/app/dist/ui/assets/LICENSE-Silkscreen-OFL.txt` present (the build and the Dockerfile's own `COPY` do not conflict, R11) |
| A7 | Quick start word for word (tarball for the name, Inspector for `claude mcp add`) | See → Stop → Prove | ✅ with finding 1: **See** — cold first start timed out at the client's 30 s connection limit, the second start read `hello` in 14 s; **Stop** — the write waited, `approvals approve` let it through, `out.txt` = `approved`; **Prove** — `keygen`, `export --report`, `verify --report` → `RESULT: PASSED`, signature valid |

Teardown: containers, network, images `node:24/22-bookworm-slim` (absent before the smoke) and the
working directory removed; the host snapshot after (containers, images, volumes, networks, listening
ports) equals the one before. Left: Docker's build cache of A6 (~0.5 GB) — removable only by a global
`docker builder prune`, which would also drop other projects' cache.

## Findings

1. **A cold first start can outlast a client's connection timeout.** `npx -y mcpcut@0.1.0 wrap -- npx -y <server>`
   downloads two packages the first time; on a busy 1-CPU container that took longer than the
   Inspector's 30 s, and the first call failed with `Connection timed out`. The second start is quick.
   The Quick start now says so in one sentence. Claude Code has a similar startup limit (`MCP_TIMEOUT`).
2. **`npx -p <pkg> mcpcut wrap -- npx -y <server>` breaks the inner `npx`.** With `-p`, npx leaves
   `npm_config_package=<pkg>` in the environment; `wrap` hands its whole environment to the server
   (by design), and the inner `npx -y <server>` then runs the server's name as a command
   (`sh: 1: @modelcontextprotocol/server-filesystem@…: not found`). The registry form
   `npx -y mcpcut@0.1.0` does not set that variable (checked with a published package), so the
   Quick start is not affected — but the "older Node" route `npx -p node@24 -p mcpcut@0.1.0 mcpcut …`
   would be, which is why the README tells older-Node users to install Node 24 instead. Recorded in
   ROADMAP as an entry-threshold candidate after the 30-day checkpoint.
3. **The smoke itself overloaded the shared host once.** The first run, uncapped, pushed the load to
   ~26 on 2 CPU while images were being unpacked, and SSH from the smoke's machine was refused for a
   while (most likely fail2ban reacting to frequent polling). Nothing else on the host was affected
   (its other service kept answering); the reruns were capped at 1 CPU / 1 GB and polled every few
   minutes.

## B. After publication

Not yet run: needs `mcpcut@0.1.0` on npm (gate G3). Plan Task 20: the real `npx -y mcpcut@0.1.0` from a
cold cache, Claude Code headless on a Mac against a service behind TLS, `npm audit signatures`.
