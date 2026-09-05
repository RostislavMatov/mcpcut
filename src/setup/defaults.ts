import { DEFAULT_SERVE_HOST, DEFAULT_SERVE_PORT } from '../cli/serve-constants.js'
import { DEFAULT_UI_HOST, DEFAULT_UI_PORT } from '../cli/ui-constants.js'
import { INSTALL_CONFIG_VERSION } from './constants.js'
import type { InstallConfig } from './schema.js'

/**
 * The config `setup` writes for a fresh install: the data directory it was
 * given, and both services on the same loopback addresses their flags already
 * default to, so writing a config changes nothing about how the plane runs.
 *
 * This lives apart from `schema.ts` on purpose. It needs `DEFAULT_UI_*`, whose
 * only permitted source is `../cli/ui-constants.js` (`src/ui/**` is off limits
 * to `src/setup/**` — ADR-0004), and that module reaches `src/admin/
 * constants.ts`, which computes paths from `JOURNAL_DIR` at import time. Were
 * this function in `schema.ts`, `config.ts → setup/data-dir → load → schema →
 * ui-constants → admin/constants → config.ts` would close a cycle and leave
 * `JOURNAL_DIR` in its temporal dead zone. Nothing in the `config.ts`
 * resolution chain imports this file.
 */
export function defaultInstallConfig(dataDir: string): InstallConfig {
  return {
    version: INSTALL_CONFIG_VERSION,
    dataDir,
    ui: { host: DEFAULT_UI_HOST, port: DEFAULT_UI_PORT },
    serve: { host: DEFAULT_SERVE_HOST, port: DEFAULT_SERVE_PORT },
  }
}
