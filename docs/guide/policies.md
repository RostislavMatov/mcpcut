# Policies, approvals and quarantine

Without a policy file, `mcpcut` behaves exactly like the plain journaling
proxy of [`wrap`](wrap-and-journal.md) (mode A): every message is forwarded unmodified, only journaled.
Dropping a `policy.json` in `./.mcpcut-project/policy.json` (project) or
`~/.mcpcut/data/policy.json` (home) turns on enforcement (mode B): every
`tools/call` is matched against the policy before it reaches the server, and
`tools/list` results are filtered to what the agent is actually allowed to
call. Running proxies re-read the policy file when it changes (checked
before each decision, at most every 250 ms), so a rule edit — by hand, from
the admin UI or via `policy set` — takes effect on the next call without a
restart; a broken edit leaves the last valid policy in force and is reported
loudly on stderr rather than silently relaxing anything.

The same goes for a policy file that did not exist yet. `setup` starts `serve`
before you have written any policy, and a `connect` session may outlive the
moment you write one: a process that started with **no** policy file (it says
`journaling only` at start-up) keeps looking where that entry point reads, and
the first **valid** `policy.json` to appear there is adopted on the next call —
`policy adopted: <path> (<hash>)` in the process's log, no restart. A file that
does not parse or validate is never adopted: the process says
`policy file not adopted: …; still journaling only` and picks it up once it is
fixed. After adoption the source is pinned exactly as if it had been there at
start-up. Two limits: sessions that were already open keep the approval
timeouts and fail-closed setting they were wired with until they are reopened,
and `wrap` without a policy is a different mode altogether (no gate is built),
so a `wrap` run still needs a restart to come under a new policy.

Resolution order (first found wins, **no merging** across sources):
`--policy <path>` → `$MCPCUT_POLICY` → `./.mcpcut-project/policy.json` →
`~/.mcpcut/data/policy.json`. A broken or explicitly-named-but-missing policy
file is a hard error: the proxy refuses to start rather than silently
degrading to allow-all.

## `policy.json` example

```json
{
  "version": 1,
  "defaultDecision": "require-approval",
  "classDefaults": {
    "read": "allow"
  },
  "servers": {
    "github": {
      "tools": {
        "delete_*": "deny"
      }
    }
  }
}
```

Every read-only tool (per its `readOnlyHint` annotation, or a matching name
heuristic) is allowed by default; anything else falls through to
`require-approval` unless a more specific rule applies. On the `github`
server, any tool whose name starts with `delete_` is denied outright,
regardless of its classification.

**`readOnlyHint` is a server-supplied hint, not a security boundary.** A
server that lies (`readOnlyHint: true` on a tool that writes) gets its tool
classified `read`, and with `classDefaults.read: "allow"` that call is
allowed. Three things bound the damage, and you should rely on them rather
than on the annotation: a tool is quarantined the first time it is advertised
(and again on every schema change), an explicit `tools` rule always beats the
classification, and `classOverrides` lets you pin a tool's class by name. The
heuristics only ever *escalate* — `destructiveHint`, a destructive name token,
or a non-ASCII confusable in the name can never be downgraded by
`readOnlyHint`. For anything that matters, write the rule; don't inherit the
hint.

A call is classified from the tool's descriptor: the one the session saw in
its own `tools/list`, or — when the agent never asked for the catalog — the one
the inventory stored the last time anyone observed that server (the
registration probe, `server refresh`, an earlier session). Only a tool nobody
has ever seen listed is classified from its name alone. Skipping `tools/list`
is the agent's choice, so it must not be a way to turn a `destructive` tool
into a `write` one.

## Recipe: `classOverrides` for servers without annotations

Some servers don't send `readOnlyHint`/`destructiveHint` at all —
`github-mcp-server` is the case that motivated this recipe: every tool,
including `search_*`, comes back unannotated, so the name-heuristic fallback
classifies it `write` (the safe default when nothing else is known). If your
policy sets `classDefaults.read: "allow"` expecting read-only search calls to
pass through automatically, this is why they don't — the tool was never
classified `read` in the first place, so `classDefaults` never applies to it.

`classOverrides` (per server, under `servers.<name>`) pins a tool's class
directly, independent of annotations or name heuristics:

```json
{
  "version": 1,
  "classDefaults": { "read": "allow" },
  "servers": {
    "github": {
      "classOverrides": {
        "search_*": "read",
        "get_*": "read"
      }
    }
  }
}
```

Same rule-name syntax as `tools` (an exact name, or a name with a single
trailing `*`). `classOverrides` only changes the *class* a tool is assigned —
the call still goes through quarantine, any matching `tools` rule, and
approvals exactly as before; it does not bypass a `deny` rule and does not
skip quarantine on a schema change (a schema change re-quarantines the tool
regardless of its class). Use it once you have manually verified that a
server's unannotated tool really is read-only — it is a statement of trust
you are making about that tool's behavior, not a way to trust the server's
own claims (which is exactly why `readOnlyHint` alone isn't enough).

Validate a policy file and inspect the effective (defaults-applied) policy:

```
mcpcut policy validate [path]
mcpcut policy show [--server <name>] [--json]
```

## Approval scenario

A `require-approval` tool call does not reach the server immediately:

1. The agent calls a gated tool. `mcpcut` enqueues an approval request
   and the call blocks (client-side) until it is resolved or times out
   (60s default).
2. An operator reviews and resolves it in another terminal:
   ```
   mcpcut approvals list
   export MCP_ADMIN_TOKEN=<your personal admin token>
   mcpcut approvals approve <id> [--reason TEXT]
   mcpcut approvals deny <id> [--reason TEXT]
   ```
   `approve` and `deny` require `MCP_ADMIN_TOKEN` — the personal token
   `mcpcut admin add` printed — and the admin behind it must hold the
   `operator` or `owner` role, the same minimum the admin UI enforces on the
   same action. The resolution is then stored as `cli:<adminName>`, so the
   journal answers *who* approved a call and not only *that* someone did.
   `approvals list` needs no token: reading the queue is not an authorization
   event. Until the install has its first admin, `approve` and `deny` need no
   token either — the first `mcpcut admin add` is token-free there anyway — and
   the resolution is stored as `cli:_unattributed` (no admin name can contain
   `_`). A token that *is* set is still checked; the first admin you add turns
   the requirement on. The same holds for `policy set`, journaled with
   `adminName: null`.

   Each pending line carries **two clocks**, and they mean different things:

   ```
   01K5…  server=github tool=create_issue class=write agent_waits=42s expires_in=4m55s args={…}
   ```

   `agent_waits` is how long the blocked call is still there to be unblocked;
   `expires_in` is how long a fresh approval stays usable. Once the first runs
   out the line says `agent_waits=elapsed(retry-only)`: approving then still
   mints the grant, but the agent has already given up and has to call again
   for it to be used. `agent_waits=unknown` means the request recorded no wait
   window. With `--json`, both deadlines are in `expiresAt` /
   `waitExpiresAt`.

   **What this does and does not buy.** It buys **attribution**, not an access
   barrier. A process running as the same user can read your environment
   anyway — that is this tool's stated threat model — so the token does not
   stop anyone who already has shell access on the host. What it does is make
   an approval name a human, so a later audit export has no anonymous entries
   in it.
3. If approved before the timeout, the original call is forwarded to the
   server and its response reaches the agent normally. If it times out (or is
   denied), the agent gets a synthetic JSON-RPC error instead — but the
   approval, once it lands, creates a short-lived **grant** for that exact
   `(server, tool, args)` triple, so an agent's retry a few minutes later
   passes without a second manual approval.

## Quarantine

The first time a server advertises a tool (or advertises one whose schema —
including its description — has changed since it was last approved),
`mcpcut` puts it in quarantine instead of trusting it automatically.
Quarantined tools are blocked (`require-approval`/`deny` per
`quarantine.onQuarantined`) until an operator reviews and approves them:

```
mcpcut quarantine list [--server <name>]
mcpcut quarantine show <server> <tool>
mcpcut quarantine approve <server> <tool>                      # needs MCP_ADMIN_TOKEN (operator)
mcpcut quarantine approve --all --server <name>                # needs MCP_ADMIN_TOKEN (operator)
mcpcut quarantine reject <server> <tool>                       # needs MCP_ADMIN_TOKEN (operator)
```

Releasing a tool from quarantine widens what every agent granted that server
can reach, so `approve` and `reject` require `MCP_ADMIN_TOKEN` — the personal
token of an admin whose role is `operator` or `owner`, the same bar the admin
UI applies to the equivalent buttons — and each release is written to the
journal as an `access-edit` record naming the admin, the server and the tool.
`list` and `show` need no token. As everywhere else, the token buys
attribution and parity with the UI's role table, not protection from a process
running as the same user.

This is a defense against a server silently changing a tool's behavior after
it was already trusted ("rug pull"): a description or schema change always
re-quarantines the tool, even if its name is unchanged.

`quarantine list` tells you a tool's schema changed; `quarantine show <server>
<tool>` tells you *how*. It prints a structural diff of the tool's
`inputSchema` against the last approved version — added/removed/changed
properties, widened/narrowed `enum`s, `required` changes — plus a
`surfaceDelta` verdict (`widened` / `narrowed` / `changed` / `neutral`)
summarizing the direction of the change. This is the same diff the admin UI's
quarantine card renders (`src/ui/pages/quarantine.ts`); the CLI is not a
second-class view of it. A brand-new tool has no approved baseline to diff
against, so `show` prints the observed descriptor instead, with an explicit
"no approved baseline" note. `surfaceDelta` never changes a tool's `read`/`write`/`destructive`
classification. It does one specific thing, described next.

### An explicit `allow` stops covering a widened tool

A per-tool rule (`servers.<name>.tools.<tool>: allow`) normally outranks
quarantine — that is the point of writing one. But such a rule is a statement
about a tool surface an operator *looked at*. If the server later advertises a
wider surface for that tool, the rule no longer describes what the tool can now
be asked to do, so it stops applying and the call falls to
`quarantine.onQuarantined` (`require-approval` by default) under the rule name
`surface-changed`. Approving the tool again in quarantine restores the rule.

The withdrawal fires when a tool that was approved has since `changed` and its
`surfaceDelta` is `widened`, the ambiguous `changed` — or could not be computed
at all. That last case matters more than it sounds: an approval made before
descriptors were stored, or a schema too large to store whole, leaves no
direction to compute, and "no signal" is not evidence of safety. A `narrowed`
or `neutral` (wording-only) change leaves the `allow` standing.

Two deliberate non-behaviours. It does nothing when `quarantine.enabled` is
`false` — that flag *is* the operator's switch for gating schema drift, and
honouring an explicit `allow` while ignoring an explicit "don't gate drift"
would be two answers to one question. And a tool in state `new` is untouched:
a rule written for a tool that was never approved was never written against an
approved surface.

Every such call is journaled like any other decision, with `rule:
surface-changed` and the `policyHash`/`grantsHash` the call was decided under
— so an auditor reading "the policy says allow, the outcome was
require-approval" can see exactly why, rather than concluding the rules changed
by themselves.

## `tools/list` filtering

When a policy is active, `tools/list` results are filtered by default
(`toolsList.filter: "hide-denied"`): tools that resolve to `deny` are removed
from what the agent sees, so it never wastes context on — or retries — a
call it cannot make. Tools resolving to `require-approval` stay visible,
since they are still callable. Set `toolsList.filter` to `"off"` to disable
filtering and show the server's full, unfiltered tool list.
