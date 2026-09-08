import type { Role } from '../admin/authz.js'
import type { TokenAdmin } from '../cli/admin-token.js'
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

/** What a run asks of the dispatcher; `display` is the argv the panel shows (phase 4 masks secrets there). */
export interface RunRequest {
  readonly actionId: string
  readonly argv: readonly string[]
  readonly display: readonly string[]
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

export type Screen =
  | {
      readonly kind: 'signin'
      readonly form: Form
      readonly notice?: string
      readonly busy: boolean
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
    }
  | {
      readonly kind: 'wizard'
      readonly mode: WizardMode
      readonly configPath: string
      readonly form: Form
      readonly stage: WizardStage
    }

/** The three screens by name, for the reducers and renderers that handle one of them. */
export type MainScreen = Extract<Screen, { kind: 'main' }>
export type SigninScreen = Extract<Screen, { kind: 'signin' }>
export type WizardScreen = Extract<Screen, { kind: 'wizard' }>

export interface Model {
  readonly screen: Screen
  readonly size: TerminalSize
}

export type Msg =
  | { readonly kind: 'key'; readonly key: KeyEvent }
  | { readonly kind: 'resize'; readonly size: TerminalSize }
  | { readonly kind: 'signin-result'; readonly result: TokenAdmin }
  | { readonly kind: 'run-result'; readonly result: RunResult }
  | { readonly kind: 'services'; readonly statuses: readonly ServiceSummary[] | undefined }
  | { readonly kind: 'session-lost' }
  | {
      readonly kind: 'wizard-run-result'
      readonly step: DeployStepId
      readonly result: RunResult
    }

export type Effect =
  | { readonly kind: 'signin'; readonly token: string }
  | { readonly kind: 'run'; readonly request: RunRequest }
  | { readonly kind: 'refresh-services' }
  | { readonly kind: 'quit'; readonly exitCode: number }
  /** One rung of the deploy ladder: dispatched with no session, since there is no admin yet. */
  | { readonly kind: 'wizard-run'; readonly step: DeployStepId; readonly request: RunRequest }
  /** The operator asked for the sign-in screen; the runtime reopens the console. */
  | { readonly kind: 'wizard-finish' }

/** One reducer step: the next model and the effects it requests, in order. */
export interface Step {
  readonly model: Model
  readonly effects: readonly Effect[]
}

/** The single field of the sign-in screen; `secret` so the renderer always masks it. */
export const SIGNIN_FIELDS: readonly FieldSpec[] = [
  { name: 'token', label: SIGNIN_TOKEN_LABEL, kind: 'secret', required: true },
]

export function initialModel(size: TerminalSize): Model {
  return {
    screen: { kind: 'signin', form: formOf(SIGNIN_FIELDS), busy: false },
    size,
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
