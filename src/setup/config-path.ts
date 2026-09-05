import { homedir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR_NAME, CONFIG_FILE_NAME, CONFIG_PATH_ENV_VAR } from './constants.js'

/**
 * Where the install config lives: `MCPCUT_CONFIG` when set, else
 * `~/.mcpcut/config.json` (phase 1, task 3).
 *
 * An empty `MCPCUT_CONFIG` counts as "not set", the same rule
 * `src/cli/admin-token.ts` applies to `MCP_ADMIN_TOKEN`: an exported-but-empty
 * variable is how shells and compose files spell "no value", and treating it
 * as a path would send every command looking at `''`.
 *
 * `homedir()` is a default argument rather than a module-level constant so a
 * test can hand in its own home without touching the process environment, and
 * so nothing is computed when the caller supplies one.
 *
 * IMPORT INVARIANT: `zod`, `node:*` and `../cli/serve-constants.js` only —
 * see the header of `./constants.ts`.
 */
export function installConfigPath(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const override = env[CONFIG_PATH_ENV_VAR]
  if (override !== undefined && override !== '') return override
  return join(home, CONFIG_DIR_NAME, CONFIG_FILE_NAME)
}
