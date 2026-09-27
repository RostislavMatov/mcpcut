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
| `list` | Every account: login, subdomain, status, dates (created, last seen, stopped). No tokens. |
| `block <login>` | Marks an `active` account `blocked` (its web session ends on its next request) and, with the provisioner link, **stops** its install — data kept. A stop that fails is a warning on stderr (the account is blocked anyway); without the link it says the install still runs. Either way the running hub's next idle sweep stops every blocked install it finds running. An account still being created (`pending`) is refused with exit 1 — try again in a minute. A block writes no tombstone; `delete` of a blocked account writes the permanent one. |
| `unblock <login>` | Reverses `block`. Starts nothing: a stopped install starts on its person's next sign-in (or by the operator). |
| `delete <login>` | Removes the account and records a tombstone (a re-signup with the same GitHub account is refused as "recently deleted" for `HUB_MIN_ACCOUNT_AGE_DAYS` — reusing that same window keeps the rule to one number instead of two). |
| `purge-tombstones` | Drops tombstones older than the retention window, so a very old block/delete stops affecting new signups from an account that has moved on. |
| `sweep [--dry-run]` | One idle sweep now (see [Idle installs](#idle-installs)), one line per active account and per blocked account whose install is not yet known stopped; `--dry-run` only prints what it would do. Needs the provisioner (`HUB_PROVISIONER_URL`); exits 1 if any account failed. `pending` accounts are left to the running hub — only it knows which of them it is still creating. |

### Idle installs

An install nobody uses is stopped, then removed (ADR-0017 phase 4, HA9). Its
**activity** is the later of two things: its person's last sign-in to the hub,
and the last time the install wrote its journal or state
(`~/.mcpcut/data/{journal,state}.db` and their `-wal` files) — the journal
takes a record on every agent call and every admin action, so an install used
only by its agents counts as used. The provisioner reads those mtimes with
`stat -c %Y` inside the running container; a stopped container is not asked,
and the date it was stopped stands in (it was stopped only once 60 days had
passed, so removal never comes early).

| Unused for | What happens |
|---|---|
| 60 days | The container is stopped (`docker stop`); its volume, network and Caddy route stay. The hub records `stopped_at`. |
| 90 days | The install (container, volume, network) is removed, and so is the account — **without** a tombstone: the person may sign up again at once and gets a fresh install. |

`serve` sweeps a minute after it starts and every six hours after that,
only with a provisioner configured; each sweep also settles `pending`
accounts again (a provisioner that was down when the hub started). Signing in
to the hub, or opening `/account`, starts a stopped install in the background
— the page says "stopped — starting…" and refreshes itself — and counts as a
sign-in. `/account` shows the dates an unused install stops and is removed on,
from the last sign-in; agent calls only move them later.

An `active` account whose install the provisioner does not have (for
example, a hub restarted in the middle of a create that was then rolled back)
is **never removed quietly**: the sweep logs `install missing, account kept for
the operator` and `/account` tells its person to contact the operator. The
operator decides — `delete <login>` (the removal is idempotent), or
`provision-create` by hand. The flag lives in the hub's memory, so after a
restart it reappears with the first sweep.

## Provisioner and tenant installs

ADR-0017 phase 3: when the hub creates an account, it does not touch Docker
itself — it calls a second, small process, the **provisioner**
(`hub/src/provisioner/*`, entry point `node hub/dist/hub/src/cli.js
provision`), which is the only thing anywhere in this deployment holding the
Docker socket. The hub only ever speaks a narrow Bearer-authenticated HTTP API
to it (`hub/src/orchestrator-http.ts`): create an install, mint or rotate its
owner token, remove it, read its state. What the provisioner may create with
the socket is fixed in code (`hub/src/provisioner/templates.ts`), not by
anything a caller — even a compromised hub — can send: one container per
tenant, capped on CPU/memory/processes, capability-less, read-only root
filesystem, on its own Docker network with no route to any other tenant or to
the host, publishing no port of its own. This is the same reasoning as
`HUB_TRUST_CF_CONNECTING_IP` above, one level down: a narrow, fixed-shape API
in front of a dangerous primitive, instead of trusting whoever holds the
primitive to always call it safely.

A tenant's install is the same `mcpcut` image as everywhere else in this
repository, built from a later stage of the root `Dockerfile`:

```bash
docker build --target tenant -t mcpcut-tenant:local .
```

(`docker-compose.site.yml` does not build this image as a compose service —
see the comment at its top — build it by hand once, and again after a change
to the `tenant` stage.) The container runs `docker/tenant-run.sh`, which
starts both `ui` and `serve` under one PID 1 and exits with whichever of them
exits first — `restart: unless-stopped` (set in the fixed container template,
not in compose) brings it back.

### Configuration

Both the provisioner and the hub read the environment below; none of it is
optional except `PROVISIONER_TOKEN_FILE`, which has no default because it is
a secret.

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `PROVISIONER_TOKEN_FILE` | provisioner | — | Path to a file holding the Bearer secret the hub must present, mode `0600`/`0400`, at least 32 visible ASCII characters (`openssl rand -hex 32` makes one). |
| `PROVISIONER_DOCKER_SOCKET` | provisioner | `/var/run/docker.sock` | Where the Docker Engine API socket is mounted. |
| `PROVISIONER_IMAGE` | provisioner | `mcpcut-tenant:local` | The image a new tenant's container is created from — the one built above. |
| `PROVISIONER_CADDY_CONTAINER` | provisioner | — (unset = a tenant is created with no route to it, useful only for a Docker-only smoke) | The name of the Caddy container the provisioner attaches every tenant's network to (`container_name: mcpcut-caddy` in `docker-compose.site.yml`), so Caddy can reach `mcpcut-t-<sub>` by name without joining that network's other members. |
| `PROVISIONER_PUBLIC_DOMAIN` | provisioner | `mcpcut.com` | The domain a tenant's install is told its own console and agent front live on (`https://<sub>.<domain>`). |
| `PROVISIONER_HOST` / `PROVISIONER_PORT` | provisioner | `0.0.0.0` / `8093` | Where the provisioner's HTTP API listens — `0.0.0.0` is safe only because, in `docker-compose.site.yml`, the only other member of its network (`hub-internal`) is `hub`. |
| `PROVISIONER_MAX_TENANTS` | provisioner | `20` | Refuses a new tenant once this many already exist on the host (a ceiling on a shared box, not a promise to any one tenant). |
| `HUB_PROVISIONER_URL` | hub | — (unset = no orchestrator; every sign-in joins the waitlist) | `http://provisioner:8093` in `docker-compose.site.yml` — the provisioner's address on `hub-internal`. Must be set together with the next variable, or neither. |
| `HUB_PROVISIONER_TOKEN_FILE` | hub | — | A file holding **the same secret** as `PROVISIONER_TOKEN_FILE` — the two processes are the two ends of one Bearer credential, each reading it from its own mounted copy of the same file (`docker-compose.site.yml` bind-mounts one host file, `secrets/provisioner-token`, read-only into both containers). |

Make the shared secret once, the same way as the GitHub client secret above:

```bash
umask 077
openssl rand -hex 32 > secrets/provisioner-token
sudo chown 1000:1000 secrets/provisioner-token   # the image's `node` user, uid 1000
```

### Giving the provisioner access to Docker

The Docker socket on the host is owned `root:docker`; the provisioner's
container runs as `node` (uid 1000, same as the hub image), so it needs the
host's `docker` group id added to its supplementary groups:

```bash
echo "DOCKER_GID=$(stat -c %g /var/run/docker.sock)" >> .env
```

`docker-compose.site.yml` passes this through `group_add:`. Widening the
socket's own permissions instead (`chmod 666`) would let anything reachable
by any process on the host talk to Docker directly — `DOCKER_GID` grants that
capability to this one container only.

### Operator commands

Like the hub's own operator CLI above, there is no panel for this — an
operator with Docker socket access already has more power than any panel
would add. Run these inside the provisioner's own container, where the
socket is:

```bash
docker compose exec provisioner node hub/dist/hub/src/cli.js provision-create <sub> <login>
docker compose exec provisioner node hub/dist/hub/src/cli.js provision-status <sub>
docker compose exec provisioner node hub/dist/hub/src/cli.js provision-remove <sub>
```

`provision-create` prints the new owner's token once, on stdout, with a
warning on stderr — nothing keeps a second copy, the same rule as the root
install's own first-owner token. `provision-status` is also the answer to
"how much disk is this tenant using": there is **no hard quota** on a
tenant's volume (O9 — Docker's own volumes are not quota-limited without a
filesystem like `xfs` with project quotas, which this deployment does not
assume); watching `provision-status` across tenants, by hand or by a script
an operator runs, is what stands in for one today. A host that needs a hard
limit is a host that has outgrown sharing one Docker daemon among tenants —
see ADR-0017's "when we reconsider" for that trigger.

An install nobody uses is stopped after 60 days and removed after 90 (see
[Idle installs](#idle-installs)); the provisioner's side of that is two more
calls, `POST /tenants/<sub>/stop` and `/start`, and `GET /tenants/<sub>`
reporting whether the container runs and its last journal/state write. The
per-tenant limit on agent calls lives in the install itself (the `tenant`
section of its config — see `docs/guide/install.md`).

### Cloudflare, for `*.mcpcut.com`

Beyond what phase 2 already needed (a proxied `mcpcut.com` and Origin Rule),
tenant routing needs:

- A proxied wildcard DNS record, `*` → this host, so every `<sub>.mcpcut.com`
  resolves through Cloudflare.
- A proxied `mcp` record (`mcp.mcpcut.com` moved behind the proxy too in this
  phase — see the Caddyfile).
- The Origin Rule (SSL/TLS → Origin Rules) covering `*.mcpcut.com` as well as
  `mcpcut.com`, sending both to this host's `:8443`.
- One Cloudflare Origin CA certificate issued for `mcpcut.com, *.mcpcut.com`
  (a single certificate covering both, not two separate ones) — see the
  Caddyfile's header comment for why the wildcard could not be added later
  without touching `mcp.mcpcut.com`'s old certificate.
- Authenticated Origin Pulls (SSL/TLS → Origin Server), the same zone-wide
  setting the Caddyfile already documents for `mcpcut.com`; it applies to
  every proxied name at once, tenants included.

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
`/privacy` and `/hub-assets/*` on `mcpcut.com` to the hub, routes
`*.mcpcut.com` to whichever tenant's own container the subdomain names
(ADR-0017 phase 3, see "Provisioner and tenant installs" above), and serves
everything else as the static preview page; and `docker-compose.site.yml`,
which builds this directory's `Dockerfile` for both `hub` and `provisioner`,
gives each its own data volume and secret mount, and starts `hub` with no
port of its own published and `provisioner` with none at all — only Caddy,
and only `hub` on its own separate network, ever reach them.
