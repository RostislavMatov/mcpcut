import { chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../vault/files.js'
import { INSTALL_CONFIG_DIR_MODE, INSTALL_CONFIG_FILE_MODE } from './constants.js'
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
 *
 * The directory's `chmod` is NOT belt and braces. `writeFileAtomic` creates
 * the parent 0700 but leaves an EXISTING one alone, and `~/.mcpcut` may well
 * predate this command — an operator who made it by hand, or a `umask 022`
 * that another tool created it under. The config holds no secrets by
 * construction (paths, ports, a supervisor word), so this is hygiene rather
 * than confidentiality; but a world-listable `~/.mcpcut` still tells every
 * co-tenant of the host that a control plane lives here and where its data
 * directory is, which is a starting point nobody needs to be handed. An errno
 * propagates (EPERM on a directory owned by someone else is exactly the case
 * an operator must be told about, not one to paper over): `setup`'s errno
 * boundary renders it as `setup: <code>: <message>`.
 */
export async function writeInstallConfig(path: string, config: InstallConfig): Promise<void> {
  const validated = installConfigSchema.safeParse(config)
  if (!validated.success) {
    throw new InstallConfigWriteRejectedError(path, formatInstallConfigErrors(validated.error))
  }

  await writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`)
  await chmod(path, INSTALL_CONFIG_FILE_MODE)
  await chmod(dirname(path), INSTALL_CONFIG_DIR_MODE)
}
