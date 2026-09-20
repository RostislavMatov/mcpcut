import { ADMIN_NAME_PATTERN } from '../admin/constants.js'
import { MAX_TCP_PORT } from '../cli/serve-constants.js'
import { BOOTSTRAP_ADMIN_NAME } from '../cli/ui-constants.js'
import { EXTERNAL_SUPERVISOR, type ServiceName } from '../services/constants.js'
import { parsePublicUrl } from '../setup/public-url.js'
import { checkBindExposure } from '../setup/bind-checks.js'
import { SUPERVISORS } from '../setup/constants.js'
import type { InstallConfig } from '../setup/schema.js'
import { formOf, type FieldSpec, type FormValues } from './form.js'
import type {
  DeployStep,
  DeployStepId,
  MintedAdmin,
  RunRequest,
  WizardMode,
  WizardScreen,
} from './model.js'

/**
 * What the first-run wizard asks, and what it does with the answers (mcpcut
 * phase 3, Task 2): the eight fields, the `setup --yes` command line they
 * build, the exposure findings they raise before anything is written, the
 * rungs of the deploy ladder, and the two lines of `setup`'s transcript that
 * carry the first admin back.
 *
 * Everything here is a pure function of a `FormValues`, which is what lets the
 * command an operator is about to run be asserted without running it. The
 * warnings are not written here either: `checkBindExposure` is the same
 * function `setup --yes` prints its findings from, so the sentence in the
 * wizard's confirmation is word for word the one the non-interactive path
 * prints — one text, two surfaces.
 */

/** The ten answers, by the name they reach `argv` builders under; the two addresses are optional. */
export const WIZARD_FIELD = {
  dataDir: 'dataDir',
  uiHost: 'uiHost',
  uiPort: 'uiPort',
  behindTls: 'behindTls',
  uiPublicUrl: 'uiPublicUrl',
  serveHost: 'serveHost',
  servePort: 'servePort',
  servePublicUrl: 'servePublicUrl',
  admin: 'admin',
  supervisor: 'supervisor',
} as const

/** What the form is filled in with: the config as it stands, and where it will go. */
export interface WizardPrefill {
  readonly mode: WizardMode
  readonly configPath: string
  readonly config: InstallConfig
  /** The name `setup --admin` was given, when the wizard was opened from that command. */
  readonly admin?: string
}

/** The flag value a `flag` field holds when it is on. */
const FLAG_ON = 'true'

/**
 * One field's value. A form always carries every field it declared, so the
 * fallback is unreachable — it is here because an index into a `Record` is
 * `string | undefined` under `noUncheckedIndexedAccess`.
 */
function valueOf(values: FormValues, name: string): string {
  return values[name] ?? ''
}

/**
 * The character that makes a typed answer read as another flag.
 *
 * `setupArgvOf` spells every answer out as `--flag value`, so a value opening
 * with a dash reaches `parseArgs` as the next option and the deploy dies with
 * "ambiguous" — a transcript that names neither the field nor the operator's
 * mistake. Refusing it in the form says which answer is wrong, while it is
 * still on screen and editable.
 */
const OPTION_LEAD = '-'

/** A directory the wizard can pass on unchanged: no tilde to expand, no dash to mistake. */
function dataDirError(value: string): string | undefined {
  // Nothing here expands a tilde — a `~` would become a directory called `~`
  // under the working directory, which is worse than a refusal.
  if (value.startsWith('~')) return 'write the full path (no ~)'

  return value.startsWith(OPTION_LEAD) ? 'write the full path (no leading -)' : undefined
}

/**
 * A bind address is checked for the one thing the form can tell: that it is an
 * answer and not a flag. What the address MEANS — loopback or the whole
 * network — is `checkBindExposure`'s business, and it is asked before anything
 * is written rather than refused here.
 */
function hostError(value: string): string | undefined {
  return value.startsWith(OPTION_LEAD) ? 'expected a host name or address' : undefined
}

/** A port is a number the TCP range holds; `0` means "any free port" and is allowed. */
function portError(value: string): string | undefined {
  return /^\d{1,5}$/.test(value) && Number(value) <= MAX_TCP_PORT
    ? undefined
    : `expected 0..${MAX_TCP_PORT}`
}

/** Both service ports are the same question asked twice. */
function portField(name: string, label: string, port: number): FieldSpec {
  return {
    name,
    label,
    kind: 'text',
    required: true,
    initial: String(port),
    hint: `0..${MAX_TCP_PORT}`,
    validate: portError,
  }
}

/**
 * The wizard's form, prefilled from the config that exists (or the defaults
 * for an install that has none). A NEW array on every call: a form is edited
 * by replacement, and a shared spec array would let one wizard's answers show
 * up in the next.
 */
export function wizardFieldsOf(prefill: WizardPrefill): readonly FieldSpec[] {
  const { config } = prefill

  return [
    {
      name: WIZARD_FIELD.dataDir,
      label: 'Data dir',
      kind: 'text',
      required: true,
      initial: config.dataDir,
      hint: 'absolute path',
      validate: dataDirError,
    },
    {
      name: WIZARD_FIELD.uiHost,
      label: 'UI host',
      kind: 'text',
      required: true,
      initial: config.ui.host,
      hint: 'this machine only: 127.0.0.1',
      validate: hostError,
    },
    portField(WIZARD_FIELD.uiPort, 'UI port', config.ui.port),
    {
      name: WIZARD_FIELD.behindTls,
      label: 'TLS in front',
      kind: 'flag',
      initial: config.ui.behindTls === true ? FLAG_ON : 'false',
      hint: 'a proxy terminates TLS (ADR-0004)',
    },
    publicUrlField(WIZARD_FIELD.uiPublicUrl, 'UI URL', '--ui-public-url', 'optional: how you will open it, http://<ip>:8091'),
    {
      name: WIZARD_FIELD.serveHost,
      label: 'Agent host',
      kind: 'text',
      required: true,
      initial: config.serve.host,
      hint: 'HTTP front for agents',
      validate: hostError,
    },
    portField(WIZARD_FIELD.servePort, 'Agent port', config.serve.port),
    publicUrlField(WIZARD_FIELD.servePublicUrl, 'Agent URL', '--serve-public-url', 'optional: what agents will dial'),
    {
      name: WIZARD_FIELD.admin,
      label: 'First admin',
      kind: 'text',
      required: true,
      initial: prefill.admin ?? BOOTSTRAP_ADMIN_NAME,
      hint: 'role owner; token shown once',
      validate: (value) =>
        ADMIN_NAME_PATTERN.test(value) ? undefined : `must match ${ADMIN_NAME_PATTERN.source}`,
    },
    {
      name: WIZARD_FIELD.supervisor,
      label: 'Services by',
      kind: 'choice',
      options: SUPERVISORS,
      initial: config.supervisor ?? SUPERVISORS[0],
      hint: 'mcpcut · external (compose/systemd)',
    },
  ]
}

/**
 * An optional public address (2026-09-19). Always EMPTY on opening, never
 * prefilled from the config: the config keeps allow-lists, not the address
 * they came from, and an empty answer adds nothing — so an edit that leaves
 * the field alone leaves every entry an earlier run wrote exactly as it was.
 * The bind and the TLS answer above are stated by the wizard on every run, so
 * here the address contributes the one thing nobody can guess: the Host and
 * Origin entries without which a request by IP is a 403.
 */
function publicUrlField(name: string, label: string, flag: string, hint: string): FieldSpec {
  return {
    name,
    label,
    kind: 'text',
    initial: '',
    hint,
    validate: (value) => {
      if (value.trim() === '') return undefined
      const parsed = parsePublicUrl(flag, value.trim())
      return parsed.ok ? undefined : parsed.message
    },
  }
}

/** The screen the wizard opens on: its form, on the form stage. */
export function wizardScreenOf(prefill: WizardPrefill): WizardScreen {
  return {
    kind: 'wizard',
    mode: prefill.mode,
    configPath: prefill.configPath,
    form: formOf(wizardFieldsOf(prefill)),
    stage: { kind: 'form' },
  }
}

/**
 * The `setup --yes` command line the answers make. Always the FULL argv, every
 * answer spelled out: `overlaySetupArgs` lays the flags over the config that
 * exists, so a field the wizard does not ask about (allowed hosts, the trusted
 * proxy header) survives an edit untouched, while everything it does ask about
 * is stated rather than inherited.
 *
 * A new array on every call — the runtime hands it to `dispatch`, which is
 * free to consume it.
 */
export function setupArgvOf(values: FormValues): readonly string[] {
  return [
    'setup',
    '--yes',
    '--data-dir',
    valueOf(values, WIZARD_FIELD.dataDir),
    '--ui-host',
    valueOf(values, WIZARD_FIELD.uiHost),
    '--ui-port',
    valueOf(values, WIZARD_FIELD.uiPort),
    '--serve-host',
    valueOf(values, WIZARD_FIELD.serveHost),
    '--serve-port',
    valueOf(values, WIZARD_FIELD.servePort),
    valueOf(values, WIZARD_FIELD.behindTls) === FLAG_ON ? '--behind-tls' : '--no-behind-tls',
    '--admin',
    valueOf(values, WIZARD_FIELD.admin),
    '--supervisor',
    valueOf(values, WIZARD_FIELD.supervisor),
    ...publicUrlArgv('--ui-public-url', valueOf(values, WIZARD_FIELD.uiPublicUrl)),
    ...publicUrlArgv('--serve-public-url', valueOf(values, WIZARD_FIELD.servePublicUrl)),
  ]
}

/** An address that was left empty is not a flag at all. */
function publicUrlArgv(flag: string, value: string): readonly string[] {
  return value.trim() === '' ? [] : [flag, value.trim()]
}

/**
 * The exposure findings the answers raise, in the words `setup` itself uses.
 * Only `warn` findings are returned: a loopback bind has nothing to confirm.
 * `serve` is asked with `behindTls: false` because the flag is the UI's alone
 * — an agent's bearer token travels in clear whatever the UI is behind.
 */
export function exposureWarningsOf(values: FormValues): readonly string[] {
  const behindTls = valueOf(values, WIZARD_FIELD.behindTls) === FLAG_ON

  return [
    checkBindExposure('ui', valueOf(values, WIZARD_FIELD.uiHost), behindTls),
    checkBindExposure('serve', valueOf(values, WIZARD_FIELD.serveHost), false),
  ]
    .filter((result) => result.level === 'warn')
    .map((result) => result.detail)
}

/** Whether the services belong to something outside this CLI, which skips both starts. */
export function isExternalSupervisor(values: FormValues): boolean {
  return valueOf(values, WIZARD_FIELD.supervisor) === EXTERNAL_SUPERVISOR
}

/** The rungs of the deploy ladder, in the order they run; frozen, as `DEFAULT_TUI_SIGNALS` is. */
export const DEPLOY_STEP_ORDER: readonly DeployStepId[] = Object.freeze([
  'setup',
  'start-ui',
  'start-serve',
] as DeployStepId[])

/** The ladder as a deploy starts: `setup` already in flight, both starts waiting. */
export function initialDeploySteps(): readonly DeployStep[] {
  return DEPLOY_STEP_ORDER.map((id): DeployStep => ({
    id,
    state: id === 'setup' ? 'running' : 'pending',
  }))
}

/** The service each `start-*` rung starts. */
const SERVICE_OF: Readonly<Record<Exclude<DeployStepId, 'setup'>, ServiceName>> = {
  'start-ui': 'ui',
  'start-serve': 'serve',
}

/**
 * What one rung asks of the dispatcher. `display` is a COPY of `argv`: the
 * transcript panel keeps it, and neither array carries a secret — `setup`
 * mints the token, it is never passed one.
 */
export function requestOf(step: DeployStepId, values: FormValues): RunRequest {
  const argv = step === 'setup' ? setupArgvOf(values) : ['start', SERVICE_OF[step]]

  return { actionId: step, argv, display: [...argv] }
}

/**
 * The two lines of `setup`'s stdout that name the admin it created
 * (`setup-steps.ts`). Pinned as constants so a rename there breaks the test
 * that asserts them rather than the wizard's final screen, which would
 * silently stop showing the one copy of the token that exists.
 */
export const MINTED_ADMIN_PREFIX = 'admin: '
export const MINTED_TOKEN_PREFIX = 'token: '

/**
 * The first admin as `setup` reported it, or nothing when this run created
 * none (a rerun over an install that already has admins prints the `admin:`
 * line but no token). Both lines are required: half an answer would put a
 * name on the final screen with nothing to save.
 */
export function mintedAdminOf(stdout: string): MintedAdmin | undefined {
  const lines = stdout.split('\n')
  const name = firstValueAfter(lines, MINTED_ADMIN_PREFIX)
  const token = firstValueAfter(lines, MINTED_TOKEN_PREFIX)
  if (name === undefined || token === undefined) return undefined

  return { name, token }
}

/** The first line starting with `prefix`, minus the prefix; `undefined` when there is none. */
function firstValueAfter(lines: readonly string[], prefix: string): string | undefined {
  const line = lines.find((each) => each.startsWith(prefix))
  if (line === undefined) return undefined

  const value = line.slice(prefix.length).trim()
  return value === '' ? undefined : value
}
