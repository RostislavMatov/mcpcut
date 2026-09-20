import { EXIT_OK } from './constants.js'
import { WELCOME_CONNECT_HTTPS_HINT } from './constants-live.js'
import { applyFormKey, formOf, valuesOf, type Form, type FieldState } from './form.js'
import type { KeyEvent } from './keys.js'
import type { RemoteUrl } from './remote/url.js'
import { CONNECT_FIELDS, CONNECT_HOST_FIELD, connectFormOf, remoteUrlOf } from './welcome-connect.js'
import type {
  Model,
  Msg,
  RemoteProbeOutcome,
  Step,
  TerminalSize,
  WelcomeScreen,
  WelcomeStage,
  WizardScreen,
} from './model.js'
import { noEffects, quit, withScreen } from './update-step.js'

/**
 * The welcome screen (2026-09-19): what a bare `mcpcut` opens on over an
 * install nothing has configured yet, in place of opening the first-run
 * wizard outright. Two choices, each a screen the console already knows how
 * to draw and drive: "set up a service" swaps `model.screen` for the SAME
 * wizard screen `openWizard` would have built (carried on `Screen` itself,
 * `screen.wizard` — a pure swap, never a second builder), and "connect"
 * opens a small form whose one field of real work, `remoteUrlOf`
 * (`welcome-connect.ts`), is shared with `--remote` itself.
 *
 * A successful connect never opens a screen of its own: it asks the runtime
 * to `reopen` this build with `--remote <url>`, so everything after that —
 * the state check, first-owner-with-code or sign-in, the plain-http warning —
 * is the ONE existing remote path (`tui-remote.ts`), not a second one grown
 * here by accident.
 */

const QUIT_CHAR = 'q'
const DOWN_CHAR = 'j'
const UP_CHAR = 'k'
const INSTALL_DIGIT = '1'
const CONNECT_DIGIT = '2'

/** The two choices, in the order they are drawn and the order their digits pick them. */
const CHOICE_COUNT = 2
const INSTALL_INDEX = 0
const CONNECT_INDEX = 1

/** The model a console over an absent, bare install opens with. */
export function welcomeModel(size: TerminalSize, wizard: WizardScreen): Model {
  return {
    screen: { kind: 'welcome', stage: { kind: 'choose', index: INSTALL_INDEX }, wizard },
    size,
  }
}

/** What opens the welcome screen directly on its "connect" stage, rather than on "choose". */
export interface ConnectEntry {
  /** The address to prefill the form with; absent opens it empty (`mcpcut --connect` with no argument). */
  readonly url?: RemoteUrl
  /**
   * Raw text to prefill the Host field with when it did NOT parse as a
   * `RemoteUrl` — `mcpcut --connect <garbage>` opens the form rather than
   * refusing, and the operator's own typo is worth keeping to edit rather
   * than retyping from nothing. Ignored when `url` is present.
   */
  readonly hostText?: string
  /** Why the operator is here already, e.g. a saved address that did not answer. */
  readonly notice?: string
  /**
   * Whether Esc from this stage goes back to "choose" (`true`, the default)
   * or quits outright (`false`) — `tui-cmd.ts` passes `false` when a local
   * install already exists, so Esc never offers "set up a service" over one
   * that is already there (ADR-0014, owner request 2026-09-20).
   */
  readonly escapesToChoose?: boolean
}

/**
 * The welcome screen opened directly on its "connect" stage (2026-09-20):
 * `mcpcut --connect [url]`, and a bare `mcpcut` whose saved address did not
 * answer. Never busy — nothing has been submitted yet, whatever prefilled it.
 */
export function welcomeConnectModel(size: TerminalSize, wizard: WizardScreen, entry: ConnectEntry = {}): Model {
  const form = connectFormFrom(entry)
  return {
    screen: {
      kind: 'welcome',
      wizard,
      stage: {
        kind: 'connect',
        form,
        busy: false,
        ...(entry.notice !== undefined ? { notice: entry.notice } : {}),
        ...(entry.escapesToChoose === false ? { escapesToChoose: false } : {}),
      },
    },
    size,
  }
}

/** `entry.url` wins; otherwise `entry.hostText` prefills only Host; otherwise a fresh form. */
function connectFormFrom(entry: ConnectEntry): Form {
  if (entry.url !== undefined) return connectFormOf(entry.url)

  const hostText = entry.hostText
  if (hostText !== undefined) {
    return formOf(CONNECT_FIELDS.map((spec) => (spec.name === CONNECT_HOST_FIELD ? { ...spec, initial: hostText } : spec)))
  }
  return formOf(CONNECT_FIELDS)
}

export function updateWelcome(model: Model, screen: WelcomeScreen, msg: Msg): Step {
  const { stage } = screen
  if (msg.kind === 'key') {
    return stage.kind === 'choose'
      ? onChooseKey(model, screen, stage, msg.key)
      : onConnectKey(model, screen, stage, msg.key)
  }
  if (msg.kind === 'connect-probe-result' && stage.kind === 'connect' && stage.busy) {
    return onProbeResult(model, screen, stage, msg.url, msg.result)
  }

  return noEffects(model)
}

function onChooseKey(
  model: Model,
  screen: WelcomeScreen,
  stage: Extract<WelcomeStage, { kind: 'choose' }>,
  key: KeyEvent,
): Step {
  if (isQuitKey(key)) return quit(model, EXIT_OK)
  if (key.kind === 'enter') return chosen(model, screen, stage.index)
  if (key.kind === 'char' && key.char === INSTALL_DIGIT) return chosen(model, screen, INSTALL_INDEX)
  if (key.kind === 'char' && key.char === CONNECT_DIGIT) return chosen(model, screen, CONNECT_INDEX)

  const delta = moveDelta(key)
  if (delta === 0) return noEffects(model)

  const index = (stage.index + delta + CHOICE_COUNT) % CHOICE_COUNT
  return withStage(model, screen, { kind: 'choose', index })
}

function moveDelta(key: KeyEvent): number {
  if (key.kind === 'down' || (key.kind === 'char' && key.char === DOWN_CHAR)) return 1
  if (key.kind === 'up' || (key.kind === 'char' && key.char === UP_CHAR)) return -1
  return 0
}

function isQuitKey(key: KeyEvent): boolean {
  return key.kind === 'escape' || (key.kind === 'char' && key.char === QUIT_CHAR)
}

/**
 * "Set up a service" swaps straight to the prebuilt wizard screen; "connect"
 * opens the form. Neither dispatches anything — the wizard's own reducer
 * (`update-wizard.ts`) and the effect below are what do the work.
 */
function chosen(model: Model, screen: WelcomeScreen, index: number): Step {
  if (index === INSTALL_INDEX) return withScreen(model, screen.wizard)

  return withStage(model, screen, { kind: 'connect', form: formOf(CONNECT_FIELDS), busy: false })
}

function onConnectKey(
  model: Model,
  screen: WelcomeScreen,
  stage: Extract<WelcomeStage, { kind: 'connect' }>,
  key: KeyEvent,
): Step {
  // Busy comes FIRST, ahead of Esc, exactly as the first-owner form's does: a
  // probe in flight is a request already sent, and a second Enter must not
  // send a second one behind it.
  if (stage.busy) return noEffects(model)
  if (key.kind === 'escape') return onConnectEscape(model, screen, stage)
  if (key.kind === 'enter') return submitConnect(model, screen, stage)

  const form = applyFormKey(stage.form, key)
  // A fresh stage rather than `{ ...stage, form }`: an edit answers whatever
  // notice the last attempt left, so the notice must not survive it —
  // `escapesToChoose` is NOT such a notice: it is a fact about how this stage
  // was ENTERED, and it must survive every edit made on it.
  return form === stage.form
    ? noEffects(model)
    : withStage(model, screen, { kind: 'connect', form, busy: false, ...escapeCarryOf(stage) })
}

/** `escapesToChoose`, carried forward only when it says "quit" — the default needs no key at all. */
function escapeCarryOf(stage: Extract<WelcomeStage, { kind: 'connect' }>): { escapesToChoose?: false } {
  return stage.escapesToChoose === false ? { escapesToChoose: false } : {}
}

/**
 * Esc from the connect form: back to "choose" ordinarily, or a quit when this
 * stage was opened directly over an install that already exists
 * (`escapesToChoose: false`, `mcpcut --connect`) — "choose" would then offer
 * "set up a service" over the very install the operator is already running
 * (ADR-0014, owner request 2026-09-20).
 */
function onConnectEscape(
  model: Model,
  screen: WelcomeScreen,
  stage: Extract<WelcomeStage, { kind: 'connect' }>,
): Step {
  if (stage.escapesToChoose === false) return quit(model, EXIT_OK)

  return withStage(model, screen, { kind: 'choose', index: CONNECT_INDEX })
}

function submitConnect(model: Model, screen: WelcomeScreen, stage: Extract<WelcomeStage, { kind: 'connect' }>): Step {
  const result = remoteUrlOf(valuesOf(stage.form))
  if (!result.ok) {
    const form = result.field === undefined ? stage.form : withFieldError(stage.form, result.field, result.message)
    const notice = result.field === undefined ? result.message : undefined
    return withStage(model, screen, {
      kind: 'connect',
      form,
      busy: false,
      ...(notice !== undefined ? { notice } : {}),
      ...escapeCarryOf(stage),
    })
  }

  return withScreen(
    model,
    { ...screen, stage: { kind: 'connect', form: stage.form, busy: true, ...escapeCarryOf(stage) } },
    [{ kind: 'connect-probe', url: result.url }],
  )
}

/**
 * The probe's answer. Success leaves the screen exactly as it stands and
 * hands the terminal over — `reopen` ends the console itself (`runtime.ts`'s
 * `enqueue`), so there is nothing left for this model to draw. Failure goes
 * back to the form, the typed values kept, with a notice — and, for an
 * attempt that used `https`, the one hint that answers the likeliest cause.
 */
function onProbeResult(
  model: Model,
  screen: WelcomeScreen,
  stage: Extract<WelcomeStage, { kind: 'connect' }>,
  url: string,
  result: RemoteProbeOutcome,
): Step {
  if (result.ok) return { model, effects: [{ kind: 'reopen', argv: ['--remote', url] }] }

  const hint = url.startsWith('https://') ? ` — ${WELCOME_CONNECT_HTTPS_HINT}` : ''
  return withStage(model, screen, {
    kind: 'connect',
    form: stage.form,
    busy: false,
    notice: `${result.message}${hint}`,
    ...escapeCarryOf(stage),
  })
}

/** A form with `message` set on exactly one field, and every other field's error cleared. */
function withFieldError(form: Form, name: string, message: string): Form {
  return {
    ...form,
    fields: form.fields.map((field) =>
      field.spec.name === name ? { spec: field.spec, value: field.value, error: message } : clearedError(field),
    ),
  }
}

function clearedError(field: FieldState): FieldState {
  return field.error === undefined ? field : { spec: field.spec, value: field.value }
}

function withStage(model: Model, screen: WelcomeScreen, stage: WelcomeStage): Step {
  return withScreen(model, { ...screen, stage })
}
