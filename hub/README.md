# hub

`hub` is the small process behind `mcpcut.com`'s "Sign in with GitHub" button
(ADR-0017 phase 2, plan `.claude/PRPs/plans/hub-signin-accounts.plan.md`). It
is not an install of `mcpcut` itself — it never reads `~/.mcpcut/config.json`
or anything an install writes (`tests/architecture/hub-imports.test.ts`
enforces that) — it only turns a GitHub identity into an account, a
subdomain, and (once the orchestrator in phase 3 exists) a call into it to
create that account's own `mcpcut` install.

What it does today:

- `GET /signin` sends a visitor to GitHub to authorize (OAuth App, PKCE).
- `GET /auth/github/callback` exchanges the code, reads the GitHub profile
  (`id`, `login`, account age), revokes the GitHub token immediately — it is
  never stored — and decides: too young an account, blocked, rate-limited, or
  welcome. A welcome either creates the account or, while phase 3's
  orchestrator is not wired up, puts the person on a waitlist with a number.
- `GET /account` and its `POST` actions: see the account's subdomain and
  status, issue a new owner token, get the client config, or delete the
  account (with the login typed back as confirmation).
- `GET /terms`, `GET /privacy` — the promises this hosted preview makes and
  what data it keeps.
- `GET /healthz` — for the container healthcheck, nothing else.

Accounts, the waitlist, and tombstones (accounts deleted or blocked, kept for
30 days so the same GitHub account cannot immediately re-register) live in
`hub.db` under `HUB_DATA_DIR` — `node:sqlite`, `STRICT` tables, keyed by the
numeric GitHub `id` (never `login`: logins change hands).

## Configuration

Every setting is an environment variable, validated at startup
(`hub/src/config.ts`); the process refuses to start rather than run on a
partially-parsed value, and prints one line per problem it found.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `HUB_PUBLIC_URL` | yes | — | The `https://` origin the hub is reached at from outside (e.g. `https://mcpcut.com`). No path, no trailing slash. |
| `HUB_GITHUB_CLIENT_ID` | yes | — | The GitHub OAuth App's client ID. Not a secret — GitHub shows it on the app's settings page. |
| `HUB_GITHUB_CLIENT_SECRET_FILE` | yes | — | Path to a file holding the OAuth App's client secret, mode `0600` (owner read/write only; a wider mode is refused). The secret is never accepted as an environment variable — a process's environment is far more exposed than a `0600` file (visible via `/proc`, crash reporters, child processes). |
| `HUB_DATA_DIR` | yes | — | Directory `hub.db` lives in. Must already exist and be writable. |
| `HUB_TENANT_DOMAIN` | no | `mcpcut.com` | The domain new accounts get a subdomain of. |
| `HUB_HOST` | no | `127.0.0.1` | Listen address. Set to `0.0.0.0` only when something else (Caddy, a compose network) is the only thing that can reach it — see [H6](#network-trust-host6) below. |
| `HUB_PORT` | no | `8092` | Listen port. |
| `HUB_MAX_ACCOUNTS` | no | `15` | How many accounts may be `active` at once. Once reached, new sign-ins join the waitlist instead. |
| `HUB_MIN_ACCOUNT_AGE_DAYS` | no | `30` | A GitHub account younger than this is refused at signup (HA12: fresh accounts are the cheapest way to abuse a free waitlist/signup flow). |
| `HUB_SIGNUPS_PER_HOUR_PER_IP` | no | `3` | Signups accepted from one IP address per rolling hour. |
| `HUB_TRUST_CF_CONNECTING_IP` | no | `0` | `1` only when the hub is reachable exclusively through Cloudflare + Caddy (see below) — set anywhere else, it lets any direct caller forge its own rate-limit key. |

### Network trust (H6)

`HUB_TRUST_CF_CONNECTING_IP=1` tells the hub to read the client's real
address from the `CF-Connecting-IP` header Cloudflare sets, instead of the
raw socket address (which would be Caddy's, the same for every visitor).
That header is only trustworthy when nothing but Cloudflare can reach the
hub's origin directly — a bare `curl` to the origin IP can set
`CF-Connecting-IP` to anything and walk straight through the signup rate
limit (`HUB_SIGNUPS_PER_HOUR_PER_IP`) otherwise. Deploying with
`docs/deploy/site/` gives the hub no published port of its own (only Caddy
can reach it, by service name on the compose network) and documents
Cloudflare Authenticated Origin Pulls in the Caddyfile as the belt-and-braces
check that a request actually transited Cloudflare.

## Build and run

From the repository root:

```bash
npm run build:hub                              # tsc -p hub/tsconfig.json → hub/dist/
node hub/dist/hub/src/cli.js serve
```

`npm run lint` type-checks both the root project and `hub/`; `npm test` runs
`hub`'s tests (`tests/hub/`) alongside everything else, and `hub/src/**` is
included in the coverage gate. `hub/` is never part of the published npm
package (`tests/architecture/hub-imports.test.ts` and `npm pack --dry-run`
both guard that).

To run it in a container, see [`docs/deploy/site/`](../docs/deploy/site/):
`hub/Dockerfile` builds the image, and
`docs/deploy/site/docker-compose.site.yml` wires it up behind Caddy alongside
the preview page and the rest of the plane.

## Operator CLI

There is no admin web panel for the hub — an operator already has shell
access to the host running it, which is a strictly bigger privilege than
anything a panel would add (the same reasoning `mcpcut` itself uses for the
hub's own accounts vs. the plane's admin UI). Everything is
`node hub/dist/hub/src/cli.js <command>`, reading the same `HUB_*`
environment as `serve`:

| Command | Effect |
|---|---|
| `list` | Every account: login, subdomain, status, dates. No tokens. |
| `block <login>` | Marks the account `blocked` and records a tombstone; an active session for it is ended. Does not yet tear down the account's own install — that is a phase 3 (orchestrator) capability; until then this prints that removal is pending. |
| `unblock <login>` | Reverses `block`. |
| `delete <login>` | Removes the account and records a tombstone (a re-signup with the same GitHub account is refused as "recently deleted" for `HUB_MIN_ACCOUNT_AGE_DAYS` — reusing that same window keeps the rule to one number instead of two). |
| `purge-tombstones` | Drops tombstones older than the retention window, so a very old block/delete stops affecting new signups from an account that has moved on. |

## Creating the GitHub OAuth App

The hub authenticates visitors as a GitHub OAuth App, not a GitHub App — it
only ever needs to read the authenticated user's public profile, once, to
create or find an account.

1. On GitHub: **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. **Application name**: `mcpcut`.
3. **Homepage URL**: `https://mcpcut.com`.
4. **Authorization callback URL**: `https://mcpcut.com/auth/github/callback`
   — must match `HUB_PUBLIC_URL` plus this exact path; GitHub checks it
   byte-for-byte.
5. **Enable Device Flow**: leave unchecked. The hub only ever does the
   authorization-code flow with PKCE from a browser.
6. Register the app, copy the **Client ID** into `HUB_GITHUB_CLIENT_ID`.
7. Click **Generate a new client secret**, then put it — and nothing else —
   into a file on the host, mode `0600`:

   ```bash
   umask 077
   printf '%s' '<the secret GitHub just showed you>' > /path/to/github-client-secret
   ```

   Point `HUB_GITHUB_CLIENT_SECRET_FILE` at that path. **Never paste the
   secret into a chat, an issue, a commit, or any file this repository
   tracks** — GitHub shows it exactly once; if it is lost or ever exposed,
   regenerate it on the app's settings page and update the file in place.

   **In Docker** (`docs/deploy/site/docker-compose.site.yml`) the file is
   bind-mounted read-only into a container that runs as the image's `node`
   user — uid 1000 in the official `node` images. A `0600` file owned by
   anyone else is unreadable there, and the hub refuses to start with
   `EACCES`. Give the file to that uid instead of widening its mode:

   ```bash
   sudo chown 1000:1000 secrets/github-client-secret
   ```

   Keep it `0600` — the hub refuses a wider mode anyway, and
   `chmod 644` would hand the secret to every user on the host.

## Deploying alongside the site

`docs/deploy/site/` has the full picture: the Caddyfile that proxies
`/signin`, `/auth/*`, `/account`, `/account/*`, `/signout`, `/terms`,
`/privacy` and `/hub-assets/*` on `mcpcut.com` to the hub and serves
everything else as the static preview page, and
`docker-compose.site.yml`, which builds this directory's `Dockerfile`, gives
the hub its own data volume and secret mount, and starts it with no port of
its own published — only Caddy, on the compose network, ever reaches it.
