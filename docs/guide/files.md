# Giving an agent folders

mcpcut has a file server built in. You declare the folders an agent may work
in, say what it may do in each (read, write, edit, delete), and the agent
reaches them through ordinary MCP tools. Every call is checked against those
rights, every delete goes to a trash you can restore from, and every call and
every rights change lands in the [journal](wrap-and-journal.md).

Use it when an agent needs files and you want the rights to live in one place
you can read, instead of in each client's config. Wrapping
`@modelcontextprotocol/server-filesystem` with [`wrap`](wrap-and-journal.md)
also works and journals the calls, but the server's rights are one allowed
folder list for everyone who starts it: no per-agent rights, no carve-outs, no
trash, no per-folder audit. This page is the other mode: a registry with an
[agent per identity](agents.md), so `research-bot` can read `~/project` while
`writer-bot` can also edit `~/project/docs` and neither can touch `~/project/secrets`.

## Quick start

You need an admin with the `owner` role and an agent (see
[Onboarding an agent](agents.md#onboarding-an-agent)); every command that
changes rights reads the owner's token from `MCP_ADMIN_TOKEN`.

```
mcpcut files root add ~/project
mcpcut files grant research-bot ~/project --ops read,write,edit
mcpcut files show research-bot
mcpcut serve
```

`root add` declares the folder, creates its trash and registers the built-in
server under the name `files` (once). It also confirms the server's tools in
the quarantine: they ship with mcpcut, so the agent's first call does not wait
for a person (after an upgrade that changed one, run `root add` again — the
folder stays as it is). `grant` gives the agent operations on
the folder and everything below it. `show` prints what the agent now holds:

```
research-bot's folder rules:
  /Users/me/project: read, write, edit
```

Connect the agent the way `agent create` printed: its client config block goes
into the agent's client (`.mcp.json` for Claude Code, `.cursor/mcp.json` for
Cursor, Claude Desktop's config) and points `connect --url` at `serve`. If you
did not keep it, `mcpcut agent config research-bot` prints the block again
with `<token>` in place of the token: mcpcut keeps only the token's hash, so a
lost token means a new agent (`agent revoke`, then `agent create` under
another name).

```
{
  "mcpServers": {
    "mcpcut": {
      "command": "npx",
      "args": ["-y", "mcpcut@0.4.1", "connect", "--url", "http://127.0.0.1:8090"],
      "env": { "MCP_AGENT_TOKEN": "mcpj_…" }
    }
  }
}
```

Restart the client. The file tools show up in the agent's pool with the
server's name in front: `files__list_roots`, `files__read_file` and so on. The
first call is `list_roots` — the tool's own description tells the agent to make
it — and it answers with what this agent may do:

```
files__list_roots  →  {"folders":[{"path":"/Users/me/project","ops":["read","write","edit"]}]}
```

An agent only ever sees its own folders, with the operations it holds there.

Next: read the journal of what it did, `mcpcut files audit`, or tighten the
rights below.

## Rights

A rule is a folder and a set of operations on it and everything inside:

| Operation | Allows |
|---|---|
| `read` | list folders, read files, get file info |
| `write` | create files and folders that do not exist yet |
| `edit` | change an existing file |
| `delete` | delete (to the trash) and move away |

`--ops` takes any of them separated by commas, or `none`.

**The most specific rule wins.** For a path, the deepest rule whose folder
contains it decides, whatever wider rules say. A deeper rule can widen or
narrow:

```
mcpcut files grant research-bot ~/project --ops read
mcpcut files grant research-bot ~/project/docs --ops read,write,edit
mcpcut files grant research-bot ~/project/docs/private --ops none
```

The agent reads all of `~/project`, edits `~/project/docs`, and gets nothing in
`~/project/docs/private`: `--ops none` carves a subfolder out. A carved-out
folder still appears by name in its parent's listing; its contents are refused.
Granting a folder again sets its operations anew: after `--ops read,write,edit`,
`--ops delete` leaves only `delete` there (`grant` says what it replaced and
prints the command that keeps both). When an agent takes its rules from
several groups, their rules on the same folder add up, except that `none` on
it wins.

A carve-out remembers the folder it was granted on. If that folder is later
moved, deleted or replaced by a new one of the same name (by another agent, or
by you), the agent's file access closes with one line until you check it and
run `mcpcut files revoke` or `mcpcut files grant` again; the content never
follows the old path to the agent it was hidden from.

**Groups** hand the same rules to many agents. A member inherits the group's
folder rules; an agent with rules of its own keeps only those, exactly as with
[server grants](agents.md#server-groups):

```
mcpcut group create docs-team
mcpcut group join docs-team writer-bot
mcpcut files grant --group docs-team ~/project/docs --ops read,write,edit
mcpcut files show --group docs-team
```

`mcpcut files show writer-bot` says which source it reads from: `(overrides
group:docs-team)` when its own rules replace the group's.

Remove one rule with `mcpcut files revoke research-bot ~/project/docs`
(`--group` for a group). A rule must lie inside a declared root; granting a
folder outside every root is refused and the message names the `root add`
command. Rights changes take effect for a connected agent within seconds, and
a client that already listed the tools asks again when told they changed.

`mcpcut files root list` prints the declared roots with the state of each
trash; `mcpcut files root remove <folder>` stops serving a folder without
deleting anything, and the agents' rules for it give nothing until it is
declared again. The limits are 50 roots and 100 folder rules per agent or group.

## The tools

| Tool | What it does | Right needed |
|---|---|---|
| `list_roots` | the folders this agent may use, and its operations in each | none |
| `list_directory` | names, kinds and sizes in a folder (up to 1000 entries) | `read` |
| `get_file_info` | kind, size, modification time, link count | `read` |
| `read_file` | the text of a file and its `sha256` (up to 10 MiB; text only) | `read` |
| `write_file` | create a file, or replace one | `write` to create, `edit` to replace; with `expectedSha256` also `read` |
| `create_directory` | create a folder whose parent exists | `write` |
| `edit_file` | replace exact text; every `oldText` must occur once, all edits apply or none (up to 100) | `read` and `edit` |
| `move_file` | move or rename a file or folder | `delete` on the source, `write` on the destination |
| `delete_file` | move a file or folder to the trash | `delete` |
| `search_files` | search by meaning, see [below](#search-by-meaning) | `read` |

Passing the `sha256` from `read_file` as `expectedSha256` to `write_file` or
`edit_file` makes the call fail with `The file changed since you read it`
instead of overwriting someone else's change. Paths are absolute. Not
allowed, whatever the rights: binary files, changing, moving or deleting a
file with several hard links (its other link could be outside the folder),
and moving or deleting a folder that contains a separately granted folder.
Reading a hard-linked file is allowed: rights follow paths, so a hard link
inside a folder the agent may read shows it that file, wherever its other
links are — even in a folder cut out with `none`. A move may not give the agent `read` or
`edit` somewhere it lacks them at the source.

The tools go through the same gate as any other server's: a
[policy](policies.md) can hold `delete_file` for approval or deny `write_file`
(`delete_file` is classed destructive, the writing tools as write), and
the agent's tool list is filtered the same way.

## Trash

`delete_file` never removes anything. It moves the file or folder into
`.mcpcut-trash` inside the root, which `root add` creates (mode 700) and which
no file tool can name. The agent is told the id:

```
Moved /Users/me/project/notes/plan.md to the trash (id 01M48SRY538NJ820NG1WJVWCNS). It is not deleted for good: an administrator can restore it by that id.
```

You list, restore and purge from the CLI (restore and purge need the owner
token):

```
mcpcut files trash list ~/project
mcpcut files trash restore ~/project 01M48SRY538NJ820NG1WJVWCNS
mcpcut files trash purge ~/project --older-than-days 7
```

`restore` puts the item back at its original path; it refuses when something
exists there now or the original folder is gone, and says which. `purge`
deletes for good; without `--older-than-days` it takes 30. `mcpcut serve` runs
the same purge once a day for everything older than 30 days. On the
[Files page](#audit) an owner has a Restore button.

## Audit

```
mcpcut files audit --agent research-bot --since 7d
```

```
2026-10-06T14:27:09.602Z  docs-bot  allow  delete_file  /Users/me/project/notes/plan.md
2026-10-06T14:26:49.646Z  docs-bot  deny  delete_file  /Users/me/project/notes/plan.md  files: no right delete on /Users/me/project/notes/plan.md
2026-10-06T14:26:32.209Z  admin alice (cli)  files.grant  for agent docs-bot  /Users/me/project
```

One line per file call, newest first, allowed and refused alike, with the
reason of a refusal, and the rights changes made by admins (`files.grant`,
`files.revoke`, `files.root.add`, restores, purges) in the same list. The
filters are `--path <file or folder>`, `--agent <name>`, `--since
<YYYY-MM-DD|Nd>` and `--limit <n>` (default 100, at most 1000); `--json`
prints one JSON object. The footer names the session to read in full:
`mcpcut show <sessionId>`. It needs no token. `tools/list` calls appear in the
list too.

The same data is on the **Files** page of the [admin UI](admin-ui.md)
(`mcpcut ui`, any role can open it; not offered on a hosted install): the
declared folders with the state of their trash, who holds which rules and from
which group, what is in the trash with a Restore button for owners, and the
audit with the same three filters. The page shows the commands for changing
rights and never runs them.

Without Postgres the audit walks the journal: a `--path` query reaches back
through thousands of sessions, and if it still stops early it says so. With
Postgres it is complete and faster: `mcpcut files db init`.

## Optional: Postgres

A local Postgres keeps an index of every file call and a catalogue of the
files under each root (path, size, hash). It is needed for a complete audit on
a busy install and for search by meaning; nothing else in the module depends
on it. The steps, in order:

```
mcpcut files setup
mcpcut vault init
mcpcut files db init
```

`files setup` installs the Postgres client into `<data dir>/modules` (no
token). `vault init` is needed once if the vault does not exist yet, because
the connection URL is stored there. The first `files db init` (owner token)
stores the URL and prints the `docker run` command that starts the bundled
container, `pgvector/pgvector:pg18` on `127.0.0.1:55432` with its own volume.
Run that command, then:

```
mcpcut files db init
mcpcut files db sync
mcpcut files db status
```

The second `db init` connects and creates the schema; `db sync` fills it
(`serve` keeps it current from then on); `db status` shows each piece in one
line and the next step. To use a Postgres you already run (search by meaning also needs the pgvector
extension), store its URL instead:
`printf '%s' 'postgres://user:pass@host:5432/db' | mcpcut vault set files-pg-url`.

If the database is unreachable the audit still answers, from the journal,
with a line saying why.

## Search by meaning

`search_files` finds passages by meaning, in the folders you chose and the
agent can read, so "the notes about the Lisbon trip" finds the file called
`travel-2025.md`. It needs Postgres (above) and runs entirely on your
machine:

```
mcpcut files setup --search
mcpcut files index on ~/project
mcpcut files db sync
```

`setup --search` installs the local runtime (onnxruntime) and downloads the
model `multilingual-e5-small` (Russian and English among others) once, about
430 MB in total, each file checked against a pinned size and hash. The
runtime comes from npm (about 300 MB) and npm prints nothing until it is done:
on a slow connection that step alone takes many minutes. After that
nothing is sent anywhere: file text is embedded on this machine and stored
in your Postgres. It is not available on Intel Macs; there the command says so
and exits.

`index on <folder>` marks a folder and its subfolders for indexing; the tool
appears in the agents' lists only once some folder is on. `index off <folder>`
turns a folder off, or cuts a subfolder out of an indexed parent;
`index list` shows the rules, the counts and what is missing. `serve` embeds
new and changed files in the background: a file an agent changed through these
tools is in the index within a minute; one changed outside them (by you, an
editor, `git`) when `serve` next walks the folders, once an hour — or at once
with `mcpcut files db sync`.

What is indexed, and what never is:

- Only text files up to 512 KiB; binary and larger files are skipped. Files
  are split into passages of about 1000 characters.
- Never, whatever the rules: folders named `.git`, `.hg`, `.svn`,
  `node_modules`, `.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`, the trash, and
  files with secret-like names: `.env` and `.env.*`, `.npmrc`, `.netrc`,
  `.pgpass`, `credentials`, `kubeconfig`, `id_rsa`-style keys, `*.pem`,
  `*.key`, `*.p12`, `*.pfx`, `*.kdbx`, `*.tfvars`, `*.tfstate`, `service-account*.json`
  and similar.
- Secrets that appear inside indexed text (tokens, keys, URL credentials) are
  masked before the text is stored, the same redaction the journal uses.

The agent gets the best passages with the path and line numbers, and only
from folders it can read: the rights are applied in the query and checked
again on every row. Calling `search_files` with a `path` needs `read` there.

Next: `mcpcut files db status` shows the index counts.

## Limits and safety

- **Symlinks.** A path is resolved to its real location before anything is
  opened, and it must land inside a declared root; a link that leads outside,
  or a dangling one, is refused. Files are opened without following a link
  swapped in at the last moment.
- **Rights follow the folder, not the spelling.** A rule matches the folder
  itself, so a different letter case or Unicode form of the same path gets the
  same answer. If a granted folder is replaced by a link or cannot be resolved,
  access is closed for that agent until you grant it again.
- **Network drives.** SMB, NFS and FUSE volumes are refused: `root add` will
  not declare a folder on one, and a path on one (a share mounted inside a
  root, or a link to it) is refused to agents. On such volumes one folder can
  report different identities under different spellings, so carve-outs could
  not be enforced. Choose a folder on a local disk.
- **Paths as sent.** An agent sends a path exactly as the disk names it — the
  names `list_directory` shows. A `.` or `..` segment, a doubled or trailing
  separator, forward slashes on Windows, another letter case or Unicode form of
  an existing name, or a path through a link is refused, so the journal always
  names the file a call acted on. Paths into `.mcpcut-project` (mcpcut's own
  project settings) are refused too.
- **Windows.** Names Windows reserves (`CON`, `NUL`, `COM1`…, a stream after
  `:`, a trailing dot or space) and device paths (`\\.\`, `\\?\`) are refused.
- **mcpcut's own data.** A root that is, lies inside or contains the data
  folder is refused, because an agent with write rights there could replace
  code mcpcut runs. `root list` marks an existing one `unsafe` and the agents
  get nothing from it.
- **Hosted installs.** The file server runs inside mcpcut on your machine; a
  hosted install refuses it, and its admin UI has no Files page.
- **Text only.** Reads and writes are UTF-8 text, at most 10 MiB per call.
- **A brake, not a sandbox.** The rights bind what an agent can do through
  these tools. An agent that also has a shell as your user reaches the files
  without them.

## Troubleshooting

| You see | Do |
|---|---|
| `Refusing to change file roots or folder rules: no admin token` | `export MCP_ADMIN_TOKEN=<owner token>`; no token yet: `mcpcut admin add <name> --role owner` |
| `<folder> does not exist: create it first` | `mkdir -p <folder>`, then `mcpcut files root add <folder>` |
| `the path must be absolute` | pass the full path, as the message suggests |
| `<folder> overlaps mcpcut's own data folder` | pick a folder outside it |
| `<folder> is on a file system that does not report stable file identities` | use a folder on a local disk |
| `<folder> is on a network or FUSE drive (smbfs)` | use a folder on a local disk; copy or sync the files there |
| `<path> is outside the declared roots` | `mcpcut files root add <folder>` first |
| `the built-in file server is not registered yet` | `mcpcut files root add <folder>` registers it |
| `a server named "files" is already registered and is not the built-in file server` | `mcpcut server remove files`, then repeat |
| `no agent "x"` | `mcpcut agent list` |
| `--ops is required` | add `--ops read` (or `none`) |
| `A trash is missing. Recreate it` | `mcpcut files root add <folder>` |
| Agent: `No right to read <path>: your rights there are none` | `mcpcut files show <agent>`, then `mcpcut files grant <agent> <folder> --ops read` |
| Agent: `The path is outside your folders` | the agent should call `list_roots` and use a path inside one |
| Agent: `Use an absolute path inside one of your folders` | same: paths must be absolute |
| Agent: `Unknown tool: files__delete_file` right after a grant | the client has not listed tools again: restart it or reopen the session |
| Agent: `File access is closed: the granted folder … now resolves to a different place` | check the folder, then `mcpcut files grant <agent> <folder> --ops …` again |
| Agent: `File access is closed: the cut-out folder … was moved, deleted or replaced` | find where the folder went; `mcpcut files grant <agent> <its new path> --ops none`, then `mcpcut files revoke <agent> <old path>` |
| Agent: `The path has a "." or ".." segment` | the agent should send the full path without them |
| Agent: `Send the path exactly as list_directory shows it` / `The path reaches the file through a link or under another spelling` | the agent should take names from `list_roots` and `list_directory` |
| Agent: `The file has several hard links` | the file cannot be changed through these tools; ask for a copy |
| Agent: `Search by meaning is not available right now` | `mcpcut files setup --search`, or `mcpcut files db status` for the reason |
| Agent: `None of the folders you can read is indexed yet` | `mcpcut files index on <folder>` |
| `Postgres at 127.0.0.1:55432 is not reachable` | `docker start mcpcut-postgres`; never created: run the command `mcpcut files db init` prints |
| `Postgres support is not installed` | `mcpcut files setup` |
| `the vault is not initialized` | `mcpcut vault init` |

Everything else the CLI says ends with the step to take next. All the
commands are in the [CLI reference](cli.md).
