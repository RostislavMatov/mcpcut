import type { Role } from '../admin/authz.js'
import type { TokenAdmin } from '../cli/admin-token.js'
import type { Supervisor } from '../setup/constants.js'
import type { InstallConfigLoad } from '../setup/load.js'
import type { SectionSpec } from './catalogue/types.js'
import { SIGNIN_TOKEN_LABEL } from './constants.js'
import { formOf, type FieldSpec, type Form } from './form.js'
import type { KeyEvent } from './keys.js'
import type { OutputPanel, RunResult } from './output.js'
import type { ServiceSummary } from './services-summary.js'

/**
 * The console's vocabulary (mcpcut phase 2, Task 8): the model the reducer
 * folds over, the messages that reach it, and the effects it asks the runtime
 * to perform. Every union is discriminated by `kind` (`TokenAdmin` precedent).
 *
 * The one thing deliberately ABSENT from this file is the admin token. A
 * `Session` carries the name and the role that the store resolved — nothing
 * else — so no frame rendered from a `Model` and no reducer branch can leak
 * the secret; the token lives in the runtime's `TokenCell` and travels to
 * `dispatch` through the `env` seam only (`session-env.ts`).
 *
 * The first-run wizard (phase 3) adds a third screen with two deliberate
 * departures. Its `form` lives on the SCREEN rather than on a stage, so
 * "back to the form" after a failed deploy returns the values the operator
 * typed rather than the prefill. And `MintedAdmin` is the one exception to
 * "never in a frame": the owner token `setup` just minted is shown once, on
 * the final screen, because the alternative is an operator hunting it out of
 * a daemon log. It enters the model when `setup` finishes, survives only as
 * far as the `done` stage (`deploying` carries it between the rungs and never
 * draws it), and leaves with the screen.
 */

export interface TerminalSize {
  readonly columns: number
  readonly rows: number
}

/** Who is signed in — the resolved identity, never the token that proved it. */
export interface Session {
  readonly adminName: string
  readonly role: Role
}

/** What a run asks of the dispatcher; `display` is the argv the panel shows, with secrets masked. */
export interface RunRequest {
  readonly actionId: string
  readonly argv: readonly string[]
  readonly display: readonly string[]
  /**
   * Where the command's stdout goes, when the action names an output path
   * (`export`). Absent — not `undefined` — when the output belongs on screen:
   * `exactOptionalPropertyTypes` is on, so the key is spread in or left out.
   */
  readonly stdoutPath?: string
  /**
   * Not dispatched here: the runtime ends the console and this argv is run as
   * a child on the same terminal; absent = an ordinary run.
   */
  readonly reopen?: true
  /**
   * The action prints a credential once (`ActionSpec.mintsToken`), so its
   * output MAY hold the token pane. Carried on the request rather than read
   * off the output, because the marker is a sentence any command's text can
   * contain and only the action knows whether a token was really minted.
   */
  readonly mintsToken?: true
}

/** What the console knows about the install it runs over; absent = an install mcpcut supervises. */
export interface InstallFacts {
  readonly supervisor: Supervisor
  /**
   * True when this console is driving a remote install over `--remote`/
   * `MCPCUT_REMOTE` (ADR-0014). Absent — never `false` — for the ordinary
   * local console, so `{ supervisor } === DEFAULT_INSTALL_FACTS`-shaped
   * objects built before wave 2 keep meaning exactly what they always meant.
   */
  readonly remote?: true
  /**
   * The origin this console is driving, present only alongside `remote` —
   * shown on the sign-in and first-owner screens so an operator always knows
   * which install a keystroke is about to reach (ADR-0014).
   */
  readonly remoteAddress?: string
  /**
   * True when `remoteAddress` is plain `http` to a non-loopback host: the
   * admin token crosses the network in clear. The loud one-time warning is on
   * stderr before the console opens (`tui-remote.ts`); this is the same fact
   * said again on the sign-in screen, which stays on screen for as long as
   * nobody has signed in.
   */
  readonly remoteInsecure?: true
}

/**
 * The supervisor value that means "mcpcut runs the daemons itself" — the
 * first of `SUPERVISORS`, written out rather than imported, because this
 * module is a leaf and a VALUE import from `setup/constants.ts` would give it
 * a runtime edge it does not otherwise have.
 */
export const OWN_SUPERVISOR: Supervisor = 'mcpcut'

export const DEFAULT_INSTALL_FACTS: InstallFacts = { supervisor: OWN_SUPERVISOR }

/**
 * What the console takes from a config load.
 *
 * Only two of `InstallConfigLoad`'s three kinds can reach a console at all:
 * `ok`, and `absent` — an install that never ran `setup` and uses the default
 * data directory. An `invalid` config never gets here, because every command
 * (the dispatcher, and `runTui` again as belt and braces) refuses on
 * `describeDataDirProblem` before a frame exists — ADR-0012 §5: a broken
 * config refuses every command rather than being guessed at. `absent`
 * therefore means "no config, so mcpcut supervises its own daemons", which is
 * the truth for that install and not a fall-back over an unread file.
 */
export function installFactsOf(install: InstallConfigLoad): InstallFacts {
  if (install.kind !== 'ok') return DEFAULT_INSTALL_FACTS
  return { supervisor: install.config.supervisor ?? OWN_SUPERVISOR }
}

/** The right-hand pane of the main screen. */
export type Pane =
  | { readonly kind: 'actions' }
  | { readonly kind: 'form'; readonly actionId: string; readonly form: Form }
  | {
      readonly kind: 'confirm'
      readonly actionId: string
      readonly request: RunRequest
      readonly question: string
    }
  | { readonly kind: 'help' }
  | { readonly kind: 'quit-confirm' }
  /** A one-time token is on the output and nobody has said they saved it yet. */
  | { readonly kind: 'token-hold' }

/** Whether the wizard is writing an install's first config, or editing one that exists. */
export type WizardMode = 'first-run' | 'edit'

/** The three commands the wizard runs, in order; both `start-*` are skipped under an external supervisor. */
export type DeployStepId = 'setup' | 'start-ui' | 'start-serve'

export type DeployStepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

/** One rung of the deploy ladder; `detail` is the sentence beside the marker. */
export interface DeployStep {
  readonly id: DeployStepId
  readonly state: DeployStepState
  readonly detail?: string
}

/** The first admin as `setup` reported it — shown once on the final screen, never elsewhere. */
export interface MintedAdmin {
  readonly name: string
  readonly token: string
}

/** Where the wizard has got to; the form itself lives on the screen, not here. */
export type WizardStage =
  | { readonly kind: 'form'; readonly notice?: string }
  | {
      readonly kind: 'confirm-exposure'
      readonly request: RunRequest
      readonly warnings: readonly string[]
    }
  /**
   * A step is in flight (`steps` has exactly one `running`); `output` is the
   * transcript of the last finished step. `admin` rides along from the moment
   * `setup` minted it until the `done` stage shows it — `setup`'s transcript
   * is gone by then, pushed out of `output` by the `start` runs, and no frame
   * of this stage draws it.
   */
  | {
      readonly kind: 'deploying'
      readonly steps: readonly DeployStep[]
      readonly output?: OutputPanel
      readonly admin?: MintedAdmin
      /** Seconds-ticks counted beside a running `start-*` step; absent before the first tick (F8). */
      readonly waitedTicks?: number
    }
  | {
      readonly kind: 'setup-failed'
      readonly steps: readonly DeployStep[]
      readonly output: OutputPanel
    }
  | {
      readonly kind: 'done'
      readonly steps: readonly DeployStep[]
      readonly admin?: MintedAdmin
      /** `q` with the token on screen asks first; this is the question being asked. */
      readonly quitAsked: boolean
    }

/**
 * Where the first-owner screen has got to (2026-09-19): the form asking for a
 * name, or the one-time token of the owner it created, held until the
 * operator says it is saved. As on the wizard's final screen, the token lives
 * in the model for exactly as long as it is on screen.
 */
export type FirstOwnerStage =
  | {
      readonly kind: 'form'
      readonly form: Form
      readonly busy: boolean
      /**
       * A remote `POST setup` refusal (`code-refused`/`invalid-name`/
       * `rate-limited`, ADR-0014): the operator stays on the form, with the
       * code already cleared, and reads why. A LOCAL `admin add` refusal
       * never sets this — it goes to the sign-in screen instead, since a
       * shell winning the race is not something retyping the form fixes.
       */
      readonly notice?: string
    }
  | {
      readonly kind: 'hold'
      readonly admin: MintedAdmin
      /** `q` with the token on screen asks first; this is the question being asked. */
      readonly quitAsked: boolean
      /**
       * The owner was created but its `access-edit` record was not (ADR-0014,
       * `POST setup`'s `journaled: false` — audit 2026-09-02, H4). Absent for
       * every local mint and every remote one that journalled cleanly.
       */
      readonly warning?: string
    }

/**
 * What a remote `POST setup` came to, folded down to what the first-owner
 * screen needs to answer — never the code, which the effect that made the
 * call already forgot.
 */
export type FirstOwnerRemoteOutcome =
  | { readonly kind: 'ok'; readonly name: string; readonly token: string; readonly journaled: boolean }
  /** `code-refused`/`invalid-name`/`rate-limited`/anything else the server said. */
  | { readonly kind: 'refused'; readonly message: string }
  /** An admin exists now (a race, or a shell got there first): sign in instead. */
  | { readonly kind: 'closed' }

/**
 * What a `connect-probe` effect answers with (2026-09-19): the welcome
 * screen's "Connect to a service on another host" asks nothing more of a
 * remote install than whether it is there at all — `EffectDeps.probeRemote`
 * (`runtime-effects.ts`) is a thin `GET state`, the same call `--remote`
 * itself makes before opening a frame (`tui-remote.ts`) — and this is its
 * whole answer.
 */
export type RemoteProbeOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string }

/**
 * Where the welcome screen has got to (2026-09-19): the console opens here
 * over an install nothing has configured yet, and asks whether THIS machine
 * is about to run the service or merely dial one that already runs somewhere
 * else. The wizard screen "Set up a service" swaps to lives on `Screen`
 * itself, not here — prebuilt once, so choosing it is a pure swap of
 * `model.screen` and never a second place that knows how to build one.
 */
export type WelcomeStage =
  | { readonly kind: 'choose'; readonly index: number }
  | {
      readonly kind: 'connect'
      readonly form: Form
      readonly busy: boolean
      /** Why the last attempt did not reach a console; cleared by the next edit. */
      readonly notice?: string
      /**
       * Where Esc goes from this stage (2026-09-20): back to "choose" when
       * absent or `true` — the ordinary path, reached by picking "connect"
       * from the choice above — and a quit when `false`, which is how
       * `mcpcut --connect` opens this stage directly over an install that
       * already exists. "choose" would then offer "set up a service" over an
       * install already there, so there is nowhere honest for Esc to go but
       * out (ADR-0014, owner request 2026-09-20).
       */
      readonly escapesToChoose?: boolean
    }

export type Screen =
  /**
   * What the console opens on when the install has NO admin: the console runs
   * under the service's uid, so it may create the owner itself (ADR-0012 §19).
   */
  | { readonly kind: 'first-owner'; readonly stage: FirstOwnerStage }
  | {
      readonly kind: 'signin'
      readonly form: Form
      readonly notice?: string
      readonly busy: boolean
      /** What `status` answered before anyone signed in; absent until it has. */
      readonly services?: readonly ServiceSummary[]
    }
  | {
      readonly kind: 'main'
      readonly session: Session
      /** Already filtered by role, so indices stay stable across renders. */
      readonly sections: readonly SectionSpec[]
      readonly sectionIndex: number
      readonly actionIndex: number
      readonly pane: Pane
      readonly output?: OutputPanel
      readonly services?: readonly ServiceSummary[]
      /** The run in flight; every key except Ctrl-C is ignored while set. */
      readonly busy?: RunRequest
      /**
       * The ID OF THE SECTION a quiet poll is out for; absent = no poll in
       * flight, and the timer may arm again. It is the section rather than a
       * flag because the answer arrives later than the keystroke that changed
       * tabs: `update-live.ts` folds it in only when the operator is still on
       * the tab that asked, so a late `approvals list` cannot appear under the
       * Journal tab.
       */
      readonly polling?: string
      /**
       * Keys pressed while a run was in flight, oldest first; replayed after
       * `run-result` unless it holds a token (phase 6, F5). Absent, never an
       * empty array, when nothing is queued.
       */
      readonly pendingKeys?: readonly KeyEvent[]
    }
  | {
      readonly kind: 'wizard'
      readonly mode: WizardMode
      readonly configPath: string
      readonly form: Form
      readonly stage: WizardStage
    }
  | {
      readonly kind: 'welcome'
      readonly stage: WelcomeStage
      /** The wizard screen "Set up a service" opens onto; built once, ahead of the choice. */
      readonly wizard: WizardScreen
    }

/** The screens by name, for the reducers and renderers that handle one of them. */
export type MainScreen = Extract<Screen, { kind: 'main' }>
export type SigninScreen = Extract<Screen, { kind: 'signin' }>
export type WizardScreen = Extract<Screen, { kind: 'wizard' }>
export type FirstOwnerScreen = Extract<Screen, { kind: 'first-owner' }>
export type WelcomeScreen = Extract<Screen, { kind: 'welcome' }>

export interface Model {
  readonly screen: Screen
  readonly size: TerminalSize
  /** What the console was told about the install; absent reads as the default. */
  readonly install?: InstallFacts
}

export type Msg =
  | { readonly kind: 'key'; readonly key: KeyEvent }
  | { readonly kind: 'resize'; readonly size: TerminalSize }
  | { readonly kind: 'signin-result'; readonly result: TokenAdmin }
  | { readonly kind: 'run-result'; readonly result: RunResult }
  | { readonly kind: 'services'; readonly statuses: readonly ServiceSummary[] | undefined }
  | { readonly kind: 'session-lost' }
  /** The console has drawn its first frame; nothing runs before it. */
  | { readonly kind: 'opened' }
  /** The auto-refresh timer fired; the reducer decides whether anything is due. */
  | { readonly kind: 'tick' }
  | { readonly kind: 'poll-result'; readonly result: RunResult }
  /** The sessionless `admin add` of the first-owner screen has answered. */
  | { readonly kind: 'first-owner-result'; readonly result: RunResult }
  /** A remote `POST setup` (ADR-0014) has answered. */
  | { readonly kind: 'first-owner-setup-result'; readonly result: FirstOwnerRemoteOutcome }
  | {
      readonly kind: 'wizard-run-result'
      readonly step: DeployStepId
      readonly result: RunResult
    }
  /** The welcome screen's `connect-probe` (2026-09-19) has answered. */
  | { readonly kind: 'connect-probe-result'; readonly url: string; readonly result: RemoteProbeOutcome }

export type Effect =
  | { readonly kind: 'signin'; readonly token: string }
  /**
   * A command to run. `stdin` — the vault secret — lives ONLY here: an effect
   * is consumed by the runtime and never stored, while `busy` and the confirm
   * pane keep the `request`, which is part of the model and must not carry a
   * secret (ADR-0004: never in a frame).
   */
  | { readonly kind: 'run'; readonly request: RunRequest; readonly stdin?: string }
  | { readonly kind: 'refresh-services' }
  /** The same command as `run`, run quietly: no `busy`, no running line, no stolen screen. */
  | { readonly kind: 'poll'; readonly request: RunRequest }
  /** The first-owner screen's `admin add`: dispatched with no session — there is no admin yet. */
  | { readonly kind: 'first-owner-run'; readonly request: RunRequest }
  /** The first-owner screen's remote `POST setup` (ADR-0014); the code lives only here. */
  | { readonly kind: 'first-owner-setup'; readonly code: string; readonly name: string }
  /** Leave the console and run this argv as a child on the same terminal. */
  | { readonly kind: 'reopen'; readonly argv: readonly string[] }
  /**
   * Leaves a remote console (2026-09-20, owner request "a way to
   * disconnect"): forgets the saved address, if any, and reopens with
   * `argv` — always `['--connect', <the address this console was driving>]`,
   * built by the reducer from `InstallFacts.remoteAddress` because the
   * catalogue's `disconnect` action has no CLI command of its own to build it
   * from. Handled like `reopen` (`runtime.ts`'s `enqueue`): the terminal is
   * about to be handed to a child process and there is nothing to wait for.
   */
  | { readonly kind: 'disconnect'; readonly argv: readonly string[] }
  | { readonly kind: 'quit'; readonly exitCode: number }
  /** One rung of the deploy ladder: dispatched with no session, since there is no admin yet. */
  | { readonly kind: 'wizard-run'; readonly step: DeployStepId; readonly request: RunRequest }
  /** The operator asked for the sign-in screen; the runtime reopens the console. */
  | { readonly kind: 'wizard-finish' }
  /** The welcome screen's "Connect": ask whether `url` answers at all (2026-09-19). */
  | { readonly kind: 'connect-probe'; readonly url: string }

/** One reducer step: the next model and the effects it requests, in order. */
export interface Step {
  readonly model: Model
  readonly effects: readonly Effect[]
}

/** The single field of the sign-in screen; `secret` so the renderer always masks it. */
export const SIGNIN_FIELDS: readonly FieldSpec[] = [
  { name: 'token', label: SIGNIN_TOKEN_LABEL, kind: 'secret', required: true },
]

export function initialModel(
  size: TerminalSize,
  install: InstallFacts = DEFAULT_INSTALL_FACTS,
): Model {
  return {
    screen: { kind: 'signin', form: formOf(SIGNIN_FIELDS), busy: false },
    size,
    install,
  }
}

export function mainScreenOf(session: Session, sections: readonly SectionSpec[]): Screen {
  return {
    kind: 'main',
    session,
    sections,
    sectionIndex: 0,
    actionIndex: 0,
    pane: { kind: 'actions' },
  }
}
