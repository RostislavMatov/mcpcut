/**
 * Constants of the install config (`~/.mcpcut/config.json`) — the file that
 * tells every `mcpcut`/`mcp-journal` process where the data directory is and
 * on which addresses the two services live (phase 1, task 2).
 *
 * Per the per-area convention (`src/cli/serve-constants.ts`, `src/policy/
 * constants.ts`) these are the setup area's own and live here, not in
 * `src/config.ts` — which is also a hard requirement here: `src/config.ts`
 * imports this module while resolving `JOURNAL_DIR`, so the dependency may
 * only ever point this way.
 *
 * IMPORT INVARIANT for this module and its neighbours in the resolution chain
 * (`schema.ts`, `config-path.ts`, `load.ts`, `data-dir.ts`): `zod`, `node:*`
 * and `../cli/serve-constants.js` (which has no imports of its own) ONLY.
 * Anything reaching back into `../config.js`, `../cli/ui-constants.js` or
 * `src/admin/**` would close an import cycle and leave `JOURNAL_DIR` in its
 * temporal dead zone at module-evaluation time.
 */

/**
 * The command an operator types. Both `bin` names run the same `dist/cli.js`
 * (C1), and every message that tells a human what to run says `mcpcut` — the
 * name the install docs use. Deliberately not `BRAND_NAME` ('McpCut'): this is
 * an argv token, not a title, and `src/brand.ts` is off the `config.ts`
 * resolution chain anyway (see the invariant above).
 */
export const CLI_NAME = 'mcpcut'

/** Directory under `$HOME` holding the install config. */
export const CONFIG_DIR_NAME = '.mcpcut'

/** File name of the install config inside `CONFIG_DIR_NAME`. */
export const CONFIG_FILE_NAME = 'config.json'

/** Overrides the whole config path (tests and multi-install hosts use it). */
export const CONFIG_PATH_ENV_VAR = 'MCPCUT_CONFIG'

/**
 * Overrides the data directory, outranking the config file. Named after the
 * journal rather than the CLI (`MCPCUT_*`) because what moves IS the journal's
 * directory — the databases, the vault and the signing key all live in it —
 * and the same name then reads correctly under both `bin` entries. The value
 * must be an ABSOLUTE path: the config field it outranks is required to be
 * one, and a relative value would mean a different directory in every shell.
 */
export const DATA_DIR_ENV_VAR = 'MCP_JOURNAL_DIR'

/** Per-service bind overrides, ranked above the config and below the flags. */
export const UI_HOST_ENV_VAR = 'MCPCUT_UI_HOST'
export const UI_PORT_ENV_VAR = 'MCPCUT_UI_PORT'
export const SERVE_HOST_ENV_VAR = 'MCPCUT_SERVE_HOST'
export const SERVE_PORT_ENV_VAR = 'MCPCUT_SERVE_PORT'

/**
 * Who owns the service processes: this CLI's own daemons, or something outside
 * (compose, systemd). The answer lives ONLY in the config's `supervisor` field
 * — there is no environment override (owner decision 2026-09-05, ADR-0012 §9):
 * it is a question for a human at first run, which the interactive wizard asks
 * and the Docker entrypoint answers with `setup --yes --supervisor external`.
 */
export const SUPERVISORS = ['mcpcut', 'external'] as const

/** One of `SUPERVISORS`. */
export type Supervisor = (typeof SUPERVISORS)[number]

/** Schema version of the install config; bumped only by a breaking shape change. */
export const INSTALL_CONFIG_VERSION = 1

/** Install config permissions: owner read/write only, like every other plane file. */
export const INSTALL_CONFIG_FILE_MODE = 0o600

/** Permissions of `~/.mcpcut`: owner-only, like the data directory. */
export const INSTALL_CONFIG_DIR_MODE = 0o700

/**
 * Name of the data directory when nothing overrides it — exactly the
 * `~/.mcp-journal` an install has always used, so a host with no config file
 * behaves byte-for-byte as before.
 */
export const DEFAULT_DATA_DIR_NAME = '.mcp-journal'

/**
 * Refuse to even parse a config larger than this. The document is a handful
 * of scalars; anything bigger is a mistake or a wedge, and reading it into
 * memory before the schema can object is the one part that is not free.
 */
export const MAX_CONFIG_BYTES = 64 * 1024

/** Bound on every string list in the config (allowed hosts, allowed origins). */
export const MAX_LIST_ENTRIES = 64

/** Longest legal DNS name; the bound on every host field. */
export const MAX_HOST_LENGTH = 253

/** Bound on the remaining free-form strings (paths, header names, origins). */
export const MAX_CONFIG_STRING_LENGTH = 1024

/**
 * The one origin value that can never be allowlisted: `"null"` is the opaque
 * origin a sandboxed or privacy-stripped browser context sends, so admitting
 * it would re-open the check it exists to fail. `src/net/origin-host.ts`
 * refuses it on the CLI flag; this file's schema refuses it in the config —
 * the constant is repeated rather than imported because `src/net/**` is off
 * limits to the `config.ts` resolution chain (see the invariant above).
 */
export const REJECTED_ORIGIN_VALUE = 'null'

// ---------------------------------------------------------------------------
// The `setup` preflight (phase 1, task 13). `src/setup/checks.ts` is NOT in
// the `config.ts` resolution chain, so these constants are free of the import
// invariant above — they live here only because the area keeps its constants
// in one file.
// ---------------------------------------------------------------------------

/**
 * File `checkDataDir` creates and immediately removes to prove the data
 * directory is writable. A `stat` cannot answer that question: it reports the
 * mode bits, not whether THIS uid may write (a read-only mount, an ACL and a
 * full disk all pass a mode check), and setup must fail before writing a
 * config that points at a directory the services cannot use.
 */
export const WRITE_PROBE_FILE_NAME = '.mcpcut-write-test'

/** The permission bits of a `stat` mode, without the file-type bits. */
export const PERMISSION_BITS_MASK = 0o777

/** Port 0 means "let the kernel pick one": there is nothing to check for a clash. */
export const EPHEMERAL_PORT = 0

/**
 * Upper bound on one bind attempt in the preflight. `--ui-host` takes a NAME,
 * and `listen()` resolves it before it binds anything: a resolver that never
 * answers would otherwise hang `setup --yes` with no output at all. Generous
 * enough that a slow-but-working DNS server is never mistaken for a dead one.
 */
export const CHECK_LISTEN_TIMEOUT_MS = 5_000

/**
 * The permission bits that belong to somebody other than the owner. A run
 * directory (pid files, daemon logs) with any of them set is readable by
 * another account on the host, which is the condition the manager refuses to
 * start on and the preflight reports first.
 */
export const GROUP_AND_OTHER_PERMISSION_BITS = 0o077

/** Every check report line starts with this, so the block reads as one table. */
export const CHECK_LINE_PREFIX = 'check  '

/**
 * Width of the check-name column in a report line. Sized to `serve exposure`,
 * the longest name any check produces: one row that overflows the column
 * shifts its own level and detail and breaks the alignment of the whole block,
 * which is the only reason the block is a table at all.
 */
export const CHECK_NAME_COLUMN = 14

/** Width of the level column: the longest level word is `fail`/`warn`. */
export const CHECK_LEVEL_COLUMN = 4

/**
 * Every IPv4 loopback address, not just `127.0.0.1`: the whole `127.0.0.0/8`
 * block is loopback, and a host bound to `127.0.0.53` (a stub resolver's
 * address, and a plausible thing to type) is no more reachable from the
 * network than `127.0.0.1`. Warning about it would train operators to ignore
 * the warning that matters.
 */
export const LOOPBACK_IPV4_PREFIX = '127.'
