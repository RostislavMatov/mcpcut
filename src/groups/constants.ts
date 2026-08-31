import { join } from 'node:path'
import { JOURNAL_DIR } from '../config.js'

/**
 * Defaults and limits for server groups (`src/groups/*`). Each area owns its
 * own `constants.ts` (same convention as `src/agents` and `src/registry`)
 * instead of sharing `src/config.ts` as a dumping ground.
 */

/** File name (document key) of the groups store inside the journal directory. */
export const GROUPS_FILE_NAME = 'groups.json'

/** Absolute path of the groups document for a given journal directory. */
export function groupsFilePath(journalDir: string = JOURNAL_DIR): string {
  return join(journalDir, GROUPS_FILE_NAME)
}

/**
 * Group names: the registry/agent name format, character for character
 * (`REGISTRY_SERVER_NAME_PATTERN`). Groups become CLI arguments, store map
 * keys and — via `group:<name>` in the `/agents` matrix — URL fragments, so
 * the same narrow lowercase DNS-label shape applies. One shared shape also
 * keeps `group:analytics` unambiguous in UI copy.
 */
export const GROUP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Max groups in one store document (bounds validation and `group list` cost). */
export const MAX_GROUPS = 100

/** Max per-server grants one group may hold (mirrors MAX_GRANTS_PER_AGENT). */
export const MAX_SERVERS_PER_GROUP = 100

/** Max agents one group may list as members (mirrors MAX_AGENTS). */
export const MAX_MEMBERS_PER_GROUP = 200
