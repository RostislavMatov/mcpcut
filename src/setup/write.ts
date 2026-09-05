import { chmod } from 'node:fs/promises'
import { writeFileAtomic } from '../vault/files.js'
import { INSTALL_CONFIG_FILE_MODE } from './constants.js'
import { formatInstallConfigErrors, installConfigSchema, type InstallConfig } from './schema.js'

/**
 * Writing `~/.mcpcut/config.json` (phase 1, task 6). The one writer: `setup`
 * calls it, and every reader is `loadInstallConfigSync`.
 *
 * Unlike the loader this module is NOT in `src/config.ts`'s import chain, so
 * it is free to reuse the plane's durable-write machinery.
 */

/**
 * The value handed in does not satisfy the install config's own schema, so
 * nothing was written. The same idea as `StoreWriteRejectedError`
 * (`src/policy/store-backend.ts`): validate BEFORE the write, so the file on
 * disk is never one this process itself would refuse to read back — a config
 * only a rewrite could fix would take every command down with it.
 */
export class InstallConfigWriteRejectedError extends Error {
  readonly problems: readonly string[]

  constructor(path: string, problems: readonly string[]) {
    super(`Refusing to write "${path}": ${problems.join('; ')}`)
    this.name = 'InstallConfigWriteRejectedError'
    this.problems = problems
  }
}

/**
 * Validates, then writes the config atomically: `writeFileAtomic`
 * (`src/vault/files.ts`) creates the parent 0700, writes a 0600 temporary in
 * the same directory, fsyncs it and renames it over the target, so a reader
 * never sees a half-written config and a crash never leaves one.
 *
 * The trailing `chmod` is belt and braces. `rename` keeps the temporary's
 * 0600, so the mode is already right on every path this code takes today;
 * the call states the requirement at the file that owns it rather than
 * leaving it as an inherited property of another module's helper.
 */
export async function writeInstallConfig(path: string, config: InstallConfig): Promise<void> {
  const validated = installConfigSchema.safeParse(config)
  if (!validated.success) {
    throw new InstallConfigWriteRejectedError(path, formatInstallConfigErrors(validated.error))
  }

  await writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`)
  await chmod(path, INSTALL_CONFIG_FILE_MODE)
}
