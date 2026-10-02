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
   01K5…  server=github tool=create_issue class=write agent=claude-code agent_wait_left=42s expires_in=4m55s args={…}
   ```

   `agent_wait_left` is how much of the agent's wait remains, so how long the
   blocked call is still there to be unblocked; `expires_in` is how long a fresh
   approval stays usable. Once the first runs out the line says
   `agent_wait=over(retry_passes_after_approve)`: approving then still
   mints the grant, but the agent has already given up and has to call again
   for it to be used. `agent_wait=unknown` means the request recorded no wait
   window. `agent=` names the agent that asked and is absent on the `wrap`
   path, which has none; `args=` is cut to 120 characters (`--json` has it whole).
   With `--json`, both deadlines are in `expiresAt` /
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

### Confirming in the client

A second rule, next to the admin's: the person at the client confirms a call
in the session. When the client can show a form (MCP form elicitation —
Claude Code does), a dialog names the tool, the server and the arguments
(secrets redacted), with **Accept** and **Decline**. Name the tools, and whose
agents they are confirmed for, under the server's `confirmInClient`:

```json
"servers": { "fs": {
  "tools":           { "delete_file": "require-approval" },
  "confirmInClient": { "write_file": ["*"], "delete_file": ["laptop"] }
} }
```

The two rules are independent:

| `tools` (the admin) | `confirmInClient` | What happens |
|---|---|---|
| allow | — | the call passes |
| allow | listed | the dialog; Accept runs the call — no admin involved |
| require-approval | — | the approval queue, as above; no dialog |
| require-approval | listed | the dialog first; Accept puts the call in the queue for an admin, Decline refuses it at once |
| deny | anything | refused; no dialog |

This is the setup for a client in full auto mode: everything passes, and only
the tools you name stop and ask you in the session. The journal records the
person's Accept as `confirmedBy: "client:<the client's name>"` (for example
`client:claude-code`); a Decline is `denied-by-operator` in the client's
name; an Esc is a plain refusal (the client may close its own dialog).

Claude Code can ask about a tool by itself, too: by its
[permission modes docs](https://code.claude.com/docs/en/permission-modes)
(checked October 2026), an `ask` permission rule such as
`mcp__fs__write_file` prompts even in auto mode and with permissions
bypassed. For one person in one client that may be all you need.
`confirmInClient` is for what an `ask` rule does not give: the same rule per agent across
clients, the answer and who gave it in the hash-chained journal, and a call
that needs both the person's Accept and an admin's approval.

- **Whose agents.** The list holds agent names, or `"*"` for every agent and
  for `mcpcut wrap` (which has no agent). An agent not on the list gets the
  admin's rule alone. Keys are written as tool rules are (an exact name, or a
  trailing `*`), but **every entry that covers the tool counts**: with
  `{ "write_*": ["*"], "write_file": ["laptop"] }`, `write_file` is confirmed
  for every agent. An exact entry can add agents to a pattern, never take
  them away — this is a stop rule, so it fails closed.
- **In the web UI.** The Servers page sets it per tool, beside the admin's
  rule: **client** → off, all, or the agents with a grant on that server. The
  buttons change only that tool's own entry; agents a `prefix*` entry already
  covers show as fixed, with the rule named — edit that one in `policy.json`.
  Servers you run under `mcpcut wrap` are not registered, so the tools the
  inventory has seen for them appear under **On this machine** on the same page
  (off / all only: `wrap` has no agent).
- **This assumes a person answers the client's dialogs.** A client driven by
  a program — an SDK host or a CI job that answers such questions on its own,
  or routes them to the model — would confirm on the agent's behalf; leave
  such agents off the list. In Claude Code, an
  [`Elicitation` hook](https://code.claude.com/docs/en/mcp) can answer the
  dialog without showing it, and with permissions bypassed an agent can edit
  Claude Code's settings — so it can answer for you. Two Accepts faster than
  a second refuse the call, but this is a brake for mistakes, like the rest of
  this page, not a sandbox.
- **Anything but an Accept refuses the call.** Decline, Esc, no answer within
  `approval.timeoutMs` (read when the session starts; the wait counts from
  the call, so with several calls at once the later dialogs have less of it),
  a client that cannot show the dialog or answers it
  with an error, and the session ending — each refuses the call and is
  recorded. It never falls back to the approval queue: the confirmation and an
  admin's approval are two rules, and one never stands in for the other. When
  the client cannot show the dialog, `wrap` and `connect` say so on stderr.
- **The agent cannot wear you down.** No more than five calls wait for a
  confirmation at once — the next is refused without a dialog. After a
  Decline or Esc, the same call (tool and arguments) is refused without a
  dialog for 30 seconds. If the client gives up a call itself (the user
  interrupts the agent), its dialog closes and the call never runs.
- **Stdio only, for now.** `wrap` and an agent's `mcpcut connect` ask in the
  client. Over HTTP (`serve`, the pool behind `connect --url`, hosted
  installs) there is no channel to ask on, so a call that needs the
  confirmation is refused.
- **An Accept faster than a second does not count.** The dialog opens with
  Accept focused, so an Enter typed into the prompt as it appears would
  accept. Such an Accept is asked once more; a second fast one refuses the
  call. With several calls waiting at once, the dialogs come one at a time.
- **Every call is confirmed on its own** — there is no window in which a
  repeat passes unasked. After an Accept the call is decided again, so a rule
  turned to `deny` while the dialog was open still wins.
- **What the dialog shows.** Every argument by name, each value cut at 160
  characters with a count of what is hidden, and every field whose value was
  hidden as a secret named; when anything is hidden, the dialog says so —
  decline if you are not sure. The rule is read for every
  call, so an edit applies without a restart.

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
