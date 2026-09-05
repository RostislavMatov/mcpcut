import { formatReadableField } from '../journal/format.js'
import { EXTERNAL_SUPERVISOR } from '../services/constants.js'
import { CLI_NAME, CONFIG_PATH_ENV_VAR, DATA_DIR_ENV_VAR } from '../setup/constants.js'

/**
 * The sentences `mcpcut setup` prints (phase 1, Task 14).
 *
 * Per the per-area convention (`serve-constants.ts`, `ui-constants.ts`) these
 * live with the command rather than in `src/config.ts`. They are gathered in
 * one file because a `setup` transcript is read as a whole: the label
 * prefixes (`setup:`, `vault:`, `admin:`) have to stay consistent with one
 * another, and that is easier to see when they sit on adjacent lines than
 * when they are scattered through the steps that print them.
 */

/**
 * Prefix of the lines that speak for the command itself rather than for one
 * artefact. The command's own name, not the binary's: a `setup` transcript
 * labels each line by what produced it (`setup:`, `vault:`, `admin:`), so an
 * operator reading a scrollback knows which step to rerun.
 */
export const SETUP_LABEL = 'setup: '

/**
 * The refusal a bare `mcpcut setup` gets. The interactive wizard is a later
 * wave (plan, "NOT Building"), and a command that silently did nothing would
 * be worse than one that says which flag turns it into the run the operator
 * wanted.
 */
export const INTERACTIVE_SETUP_PENDING =
  'Interactive setup arrives with the console (a later wave). ' +
  `Run non-interactively: ${CLI_NAME} setup --yes …\n`

/** The vault already had a key; nothing was generated and nothing was touched. */
export const VAULT_ALREADY_INITIALIZED = 'vault: already initialized\n'

/**
 * A signing key already exists. `keygen` treats this as a refusal (rotating a
 * key invalidates every anchor signed with it), but a `setup` rerun is not a
 * rotation attempt — it is an operator making sure the install is complete —
 * so here it is a result on stdout, not an error.
 */
export const SIGNING_KEY_PRESENT = 'signing key: already present\n'

/** `--start` on an install whose services belong to compose or systemd. */
export const EXTERNAL_SUPERVISOR_NOTICE =
  `services: managed externally (supervisor: ${EXTERNAL_SUPERVISOR}), not started\n`

/** How many admins already exist, so a rerun says why it minted nothing. */
export function adminsAlreadyExist(count: number): string {
  return `admin: ${count} admin(s) exist, none created\n`
}

/**
 * The warning `--no-admin` earns. Skipping the owner does not remove the
 * bootstrap — it moves it: the first `ui` start creates `owner` itself and
 * writes the plaintext token to its own stderr, which the manager points at
 * the daemon log. That file is then a live credential on disk, and an
 * operator who chose this path has to be told so in the same breath.
 */
export function noAdminWarning(uiLogPath: string): string {
  return (
    `${SETUP_LABEL}--no-admin: this install has no admin yet. The first "ui" start will create ` +
    `"owner" and print its token into ${uiLogPath} — treat that file as a secret, ` +
    `or run "${CLI_NAME} admin add <name> --role owner" before starting anything.\n`
  )
}

/**
 * The refusal for an install config this build cannot read, when `--force`
 * was not given. Same shape as `describeDataDirProblem`
 * (`src/setup/data-dir.ts`) and the refusals in `admin-token.ts`: state the
 * fault, name the file, then the two ways forward. Overwriting a file whose
 * contents were meant to configure this install is not something to do
 * without being asked.
 */
export function unusableConfigRefusal(path: string, problems: readonly string[]): string {
  const detail = problems.map((problem) => `  ${problem}`).join('\n')
  return (
    `${SETUP_LABEL}install config ${path} is unusable:\n${detail}\n` +
    `Fix it by hand, point ${CONFIG_PATH_ENV_VAR} at another file, or rerun with --force ` +
    'to overwrite it with a fresh one.\n'
  )
}

/** Where the config ended up — the first thing an operator needs from a green run. */
export function configWritten(path: string): string {
  return `${SETUP_LABEL}config written to ${path}\n`
}

/** The vault key this run created. */
export function vaultInitialized(keyPath: string): string {
  return `vault: initialized ${keyPath}\n`
}

/**
 * A vault that answered with neither "initialized" nor "already initialized".
 * `init()` reaches this only through a corrupt key file, which no later step
 * could work around — the install is not ready and must not be reported as if
 * it were.
 */
export function vaultRefused(status: string): string {
  return `${SETUP_LABEL}the vault could not be initialized (${status})\n`
}

/**
 * The refusal for a run whose environment and whose config disagree about the
 * data directory (TS-H3 / SEC-M5).
 *
 * `setup` can neither honour `MCP_JOURNAL_DIR` nor ignore it. Honouring it
 * would write a `dataDir` the operator did not ask for; ignoring it would
 * prepare one directory while every later command — this CLI, the daemons,
 * the `ui` that mints the first owner — uses the other. So it says so and
 * stops, before anything on the host is touched.
 */
export function dataDirConflict(exported: string, configured: string): string {
  const seen = formatReadableField(exported)
  return (
    `${SETUP_LABEL}${DATA_DIR_ENV_VAR} is set to ${seen}, but this run would write ` +
    `${configured} into the install config.\n` +
    `Every other command ranks ${DATA_DIR_ENV_VAR} above the config, so setup would prepare one ` +
    'directory while the services served the other.\n' +
    `Run: unset ${DATA_DIR_ENV_VAR}, or pass --data-dir ${seen}\n`
  )
}

/**
 * A fault of the host rather than of the plane — an unwritable config
 * directory, a full disk. It gets a line, the boundary `service-cmd.ts` draws;
 * anything without an errno is this plane being wrong about itself and keeps
 * its stack trace.
 */
export function hostFault(detail: string): string {
  return `${SETUP_LABEL}${detail}\n`
}
