import type { TenantSettings } from '../tenant/settings.js'

/**
 * ADR-0017 T6: what `console-run.ts` refuses ON TOP OF its allowlist and role
 * floor once the install's `TenantSettings.isTenant` is true. A hosted owner
 * is `owner` of THEIR install, not of the host it happens to run on --
 * `docs/adr/0014-remote-console.md` already prices that out for every other
 * command the remote console runs ("owner-token over the network is roughly
 * shell on the server"); tenant mode is the one place that price is refused
 * back, for the commands that would actually spend it.
 *
 * Three refused shapes:
 *
 *  - a first word that IS a whole-host operation: `backup`/`migrate` read or
 *    write files under the install's own data directory via a POSITIONAL
 *    argument (`backup <destDir>`), which no flag check below would ever see;
 *    `start`/`stop`/`logs` reach the host's service manager, not this
 *    install (the exact thing ADR-0012 §19's "console == shell under the
 *    service's uid" gives away, and RC1 already narrowed once for the
 *    network -- this narrows it again for a tenant);
 *  - `policy validate [path]` -- its one positional argument is an arbitrary
 *    file to read, unrelated to the policy the install actually serves
 *    (`policy show` is a separate command, gated on its own `--policy` flag
 *    below);
 *  - any argv carrying one of TENANT_PATH_FLAGS, in either `--flag value` or
 *    `--flag=value` form.
 *
 * TENANT_PATH_FLAGS is exhaustive over `CONSOLE_ALLOWED_FIRST_WORDS` as of
 * this writing -- every `parseArgs` `options` table in `src/cli/*-args.ts`
 * and `src/cli/*-cmd.ts` reachable through that allowlist was grepped for a
 * flag whose value is a path on the machine running the command:
 *   - `--policy`  -- `policy show --policy <path>` (`policy-cmd.ts`)
 *   - `--out`     -- `export --out <dir>` (`export-cmd.ts`)
 *   - `--report`  -- `verify --report <dir>` (`verify-cmd.ts`, a path); ALSO
 *                    `export --report` (`export-cmd.ts`), a same-named
 *                    BOOLEAN switch that still writes a report directory on
 *                    the server when set -- refusing the flag regardless of
 *                    its type is deliberate, not an oversight
 *   - `--pub`     -- `verify --report ... --pub <path>` (`verify-cmd.ts`)
 * Checked and deliberately excluded: `server add`'s `--url`/`--command`/
 * `--transport` name an upstream address or a shell command, never a
 * server-local path (and a stdio `--command` is refused at the registry
 * store regardless of the console, see `registry/store.ts`'s tenant gate);
 * `agent`/`group`'s `--tools`/`--resources`/`--prompts` are comma-separated
 * names, not paths; `service`'s `--lines` is a count. This list is exhaustive
 * BY INSPECTION of the CLI as it stands, not by construction -- a new
 * path-shaped flag added to an allowlisted command later is a gap this list
 * does not close by itself.
 */
export const TENANT_REFUSED_FIRST_WORDS: ReadonlySet<string> = new Set([
  'backup',
  'migrate',
  'start',
  'stop',
  'logs',
])

/** See the module doc above for where each of these comes from. */
export const TENANT_PATH_FLAGS: readonly string[] = ['--policy', '--out', '--report', '--pub']

export const TENANT_PATH_REFUSED_MESSAGE =
  'This command names a path on the server; a hosted install does not run it (tenant mode).'

function isPolicyValidate(argv: readonly string[]): boolean {
  return argv[0] === 'policy' && argv[1] === 'validate'
}

/**
 * True for `--flag` and `--flag=value` alike. A private mirror of
 * `console-run.ts`'s own `hasFlag` (that module cannot import this one back
 * without a cycle, and the check is two lines) -- kept in lockstep by
 * `tests/tenant/console-tenant.test.ts` exercising both flag shapes.
 */
function hasTenantPathFlag(argv: readonly string[], flag: string): boolean {
  return argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))
}

/**
 * Whether an already-allowlisted argv is refused under tenant mode. Takes
 * the resolved settings as a parameter, rather than reading `TENANT_SETTINGS`
 * itself, so a self-hosted test never has to know this module exists and a
 * tenant test never has to touch the real install config.
 */
export function isTenantPathRefused(argv: readonly string[], tenant: TenantSettings): boolean {
  if (!tenant.isTenant) return false
  const first = argv[0]
  if (first !== undefined && TENANT_REFUSED_FIRST_WORDS.has(first)) return true
  if (isPolicyValidate(argv)) return true
  return TENANT_PATH_FLAGS.some((flag) => hasTenantPathFlag(argv, flag))
}
