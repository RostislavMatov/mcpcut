import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'

/**
 * Defaults and limits for the agent-identity store (`src/agents/*`). Kept out
 * of `src/config.ts` per the M2 convention: each area owns its own
 * `constants.ts` instead of sharing a dumping ground.
 */

/** File name of the agents store inside the journal directory. */
export const AGENTS_FILE_NAME = 'agents.json'

/** Default absolute path of the agents store (tests inject their own dir). */
export const AGENTS_FILE_PATH = join(JOURNAL_DIR, AGENTS_FILE_NAME)

/**
 * Prefix of every agent token. A recognizable prefix lets secret scanners
 * (and our own redaction patterns) identify a leaked token by shape, the same
 * way `ghp_`/`sk-` prefixes do for GitHub/OpenAI keys.
 */
export const AGENT_TOKEN_PREFIX = 'mcpj_'

/** Random entropy per token: 32 bytes ≈ 256 bits, base64url-encoded to 43 chars. */
export const TOKEN_RANDOM_BYTES = 32

/** Shape of a stored token hash: the full sha256 hex digest, nothing shorter. */
export const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/

/**
 * Agent names become CLI arguments, journal fields and (in M3 Wave 3) URL
 * path segments, so the format is deliberately narrow: lowercase DNS-label
 * style, 1–64 chars. Same shape as registry server names.
 */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Server names inside `grants` use the registry name format. Whether the
 * server actually EXISTS in the registry is checked by the layer that has
 * both stores, not here: `cli/access-cmd-write.ts` (`requireRegisteredServer`,
 * in front of `agent grant` and `group grant`) and the UI grant handlers
 * (`ui/handlers/agents.ts`, `ui/handlers/groups.ts`) refuse an unregistered
 * name before the write (owner decision S1, 2026-09-03). This store
 * deliberately has no dependency on `src/registry`, so `ungrant` keeps
 * working for a grant whose server was since removed.
 */
export const GRANT_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Max agents in one store file (same DoS-bounding rationale as MAX_SERVERS_IN_POLICY). */
export const MAX_AGENTS = 200

/** Max per-server grants a single agent may hold. */
export const MAX_GRANTS_PER_AGENT = 100

/** Max tool patterns in a single grant (mirrors MAX_TOOL_RULES_PER_SERVER). */
export const MAX_TOOLS_PER_GRANT = 500
