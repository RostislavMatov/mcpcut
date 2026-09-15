import { bootstrapTokenPathFor } from '../admin/bootstrap-file.js'
import { createAdminStore } from '../admin/store.js'
import { formatReadableField } from '../journal/format.js'
import {
  generateAndWriteSigningKeyPair,
  SigningKeyExistsError,
} from '../journal/signing.js'
import { EXTERNAL_SUPERVISOR, SERVICE_NAMES } from '../services/constants.js'
import { formatStartResult } from '../services/format.js'
import type { ServiceManager } from '../services/manager.js'
import type { InstallConfig } from '../setup/schema.js'
import { createVaultStore } from '../vault/store.js'
import { isExpectedAdminError } from './admin-cmd.js'
import type { SetupArgs } from './setup-args.js'
import {
  adminsAlreadyExist,
  EXTERNAL_SUPERVISOR_NOTICE,
  noAdminWarning,
  SIGNING_KEY_PRESENT,
  VAULT_ALREADY_INITIALIZED,
  vaultInitialized,
  vaultRefused,
} from './setup-constants.js'
import { BOOTSTRAP_ADMIN_NAME, TOKEN_ONCE_NOTICE, TOKEN_STDOUT_REDIRECT_WARNING, type UiCliIo } from './ui-constants.js'

/**
 * Steps 7–10 of `mcpcut setup --yes` (phase 1, Task 14): the vault, the
 * signing key, the first admin and the optional start.
 *
 * Split from `setup-cmd.ts` for the file-size budget, the way
 * `server-add-args.ts` and `server-remove-cascade.ts` were split off their
 * commands. Every step here runs AFTER the config has been written and every
 * check has passed, and every one of them is idempotent: a rerun of `setup`
 * over a finished install must add nothing and refuse nothing.
 */

/** The role the first admin of an install gets. There is no other useful one to bootstrap with. */
const BOOTSTRAP_ADMIN_ROLE = 'owner'

/**
 * Creates the vault's master key, or reports the one already there.
 *
 * Returns `false` only for a vault that answered with a failure status, which
 * no later step could work around — the run stops rather than reporting an
 * install that is not usable.
 */
export async function prepareVault(io: UiCliIo, dataDir: string): Promise<boolean> {
  const result = await createVaultStore({ journalDir: dataDir }).init()
  if (result.status === 'initialized') {
    io.stdout.write(vaultInitialized(result.keyPath))
    return true
  }
  if (result.status === 'already-initialized') {
    io.stdout.write(VAULT_ALREADY_INITIALIZED)
    return true
  }
  io.stderr.write(vaultRefused(result.status))
  return false
}

/**
 * Generates this installation's Ed25519 signing key, printing exactly what
 * `keygen` prints — an operator who ran `setup` must end up holding the same
 * public key and fingerprint as one who ran `keygen`, in the same words, or
 * the two paths would produce two different handover procedures.
 *
 * An existing key is a result, not a refusal: see `SIGNING_KEY_PRESENT`.
 */
export async function prepareSigningKey(io: UiCliIo, dataDir: string): Promise<void> {
  try {
    const generated = await generateAndWriteSigningKeyPair(dataDir)
    io.stdout.write(`Signing key written to: ${generated.privateKeyPath}\n`)
    io.stdout.write(`Public key written to:  ${generated.publicKeyPath}\n\n`)
    io.stdout.write('Public key (hand this to your auditor):\n')
    io.stdout.write(`${generated.publicKeyPem}\n`)
    io.stdout.write(`Fingerprint (sha256 of SPKI DER, hex): ${generated.publicKeyFingerprint}\n`)
  } catch (error: unknown) {
    if (error instanceof SigningKeyExistsError) {
      io.stdout.write(SIGNING_KEY_PRESENT)
      return
    }
    throw error
  }
}

/**
 * Mints the install's first owner and prints its token once — the whole point
 * of owner decision C6. The admin is created HERE, before any daemon exists,
 * so the token reaches a human on stdout instead of waiting in the bootstrap
 * token file the way the `ui` bootstrap would leave it (phase 6, F6).
 *
 * The output is `admin add`'s, line for line (`admin-cmd.ts`'s `runAdd`): one
 * shape for a one-time token across the whole CLI, so the two notices that
 * follow it are never accidentally dropped from one of the two paths.
 */
export async function prepareAdmin(
  io: UiCliIo,
  dataDir: string,
  args: SetupArgs,
  clock?: () => Date,
): Promise<boolean> {
  if (args.noAdmin) {
    io.stderr.write(noAdminWarning(bootstrapTokenPathFor(dataDir)))
    return true
  }

  const store = createAdminStore({
    journalDir: dataDir,
    ...(clock !== undefined ? { clock } : {}),
  })
  try {
    const existing = await store.listAdmins()
    if (existing.length > 0) {
      io.stdout.write(adminsAlreadyExist(existing.length))
      return true
    }
    const { admin, token } = await store.createAdmin(
      args.admin ?? BOOTSTRAP_ADMIN_NAME,
      BOOTSTRAP_ADMIN_ROLE,
    )
    io.stdout.write(`admin: ${formatReadableField(admin.name)}\n`)
    io.stdout.write(`role: ${admin.role}\n`)
    io.stdout.write(`token: ${token}\n`)
    io.stdout.write(TOKEN_ONCE_NOTICE)
    io.stdout.write(TOKEN_STDOUT_REDIRECT_WARNING)
    return true
  } catch (error: unknown) {
    // The same classification `admin add` uses, so an invalid `--admin` name
    // refuses identically here and there instead of crashing one of them.
    if (isExpectedAdminError(error)) {
      io.stderr.write(`${formatReadableField(error.message)}\n`)
      return false
    }
    throw error
  }
}

/**
 * `--start`: brings both services up, `ui` first, and returns the exit code.
 *
 * An install whose `supervisor` is `external` starts nothing — its processes
 * belong to compose or systemd, and spawning a second copy would take the
 * port the real one is meant to hold. The state is reported rather than
 * treated as an error: it is the configuration the operator asked for.
 */
export async function startServices(
  io: UiCliIo,
  config: InstallConfig,
  args: SetupArgs,
  manager: ServiceManager,
): Promise<number> {
  if (!args.start) return 0
  if (config.supervisor === EXTERNAL_SUPERVISOR) {
    io.stdout.write(EXTERNAL_SUPERVISOR_NOTICE)
    return 0
  }

  let failed = false
  for (const service of SERVICE_NAMES) {
    const result = await manager.start(service)
    io.stdout.write(formatStartResult(service, result))
    // `unsupported` is not `failed`, but it is just as much "the services the
    // operator asked for are not running" — `service-cmd.ts` counts it the
    // same way, and the two must not disagree about the same outcome.
    if (result.kind === 'failed' || result.kind === 'unsupported') failed = true
  }
  return failed ? 1 : 0
}
