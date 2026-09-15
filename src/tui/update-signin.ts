import type { TokenAdmin } from '../cli/admin-token.js'
import { SECTIONS, visibleSections } from './catalogue/index.js'
import { EXIT_OK, SIGNIN_UNKNOWN_TOKEN_NOTICE } from './constants.js'
import { clearSecrets, editFocused, type Form } from './form.js'
import type { KeyEvent } from './keys.js'
import {
  DEFAULT_INSTALL_FACTS,
  initialModel,
  mainScreenOf,
  type InstallFacts,
  type Model,
  type Msg,
  type Screen,
  type Step,
  type TerminalSize,
} from './model.js'
import type { ServiceSummary } from './services-summary.js'
import { noEffects, quit, withScreen } from './update-step.js'

/**
 * The sign-in screen (mcpcut phase 2, Task 9).
 *
 * One field, three outcomes and a discipline: the moment `Enter` hands the
 * token to the effect that resolves it, the field is REPLACED by an empty one
 * (`clearSecrets`). From then on the model holds a name and a role and nothing
 * that could authenticate anybody — which is what makes "the token is never in
 * a frame" a property of the type rather than a property of the renderer.
 *
 * The screen still ignores `run-result`: it is the answer to a session that has
 * already ended (`session-lost` races an effect that was already in flight),
 * and folding it in would put a dead session's output on the screen of whoever
 * signs in next. `services` is NOT ignored any more (phase 5, plan P3) — what
 * the daemons are doing is a fact about the HOST, true whoever is signed in,
 * and the screen asks for it itself when the console opens so an operator can
 * see that a service is down before they wonder why nothing answers.
 */

/** The sign-in variant of `Screen`, named for the reducers that receive it. */
import type { SigninScreen } from './model.js'

export type { SigninScreen } from './model.js'

/**
 * What `Enter` on an empty field says. It belongs here rather than in
 * `constants.ts`: it is a prompt about this one keystroke, not a sentence the
 * renderer or the runtime has any business knowing.
 */
export const EMPTY_TOKEN_NOTICE = 'Enter your admin token'

/** Folds one message into the sign-in screen. */
export function updateSignin(model: Model, screen: SigninScreen, msg: Msg): Step {
  if (msg.kind === 'key') return applyKey(model, screen, msg.key)
  if (msg.kind === 'signin-result') return applyResult(model, screen, msg.result)
  // Nobody has signed in, so the request goes out under the console's own
  // environment rather than a session's (`runtime-effects.ts`).
  if (msg.kind === 'opened') return { model, effects: [{ kind: 'refresh-services' }] }
  if (msg.kind === 'services') return withScreen(model, withServices(screen, msg.statuses))

  // `run-result` and a second `session-lost` belong to a session that is
  // already over; `resize` never reaches here (`update.ts` takes it).
  return noEffects(model)
}

/**
 * The same screen with the service line replaced — and with the key GONE when
 * the status could not be read, so "we have not asked" and "we asked and got
 * nothing" are the same absent field rather than two shapes the renderer would
 * have to tell apart (`exactOptionalPropertyTypes`).
 */
function withServices(
  screen: SigninScreen,
  statuses: readonly ServiceSummary[] | undefined,
): Screen {
  return {
    kind: 'signin',
    form: screen.form,
    busy: screen.busy,
    ...(screen.notice !== undefined ? { notice: screen.notice } : {}),
    ...(statuses !== undefined ? { services: statuses } : {}),
    ...bootstrapFactOf(screen),
  }
}

/** The facts about the HOST a sign-in screen carries, which outlive one attempt to sign in. */
type CarriedHostFacts = Pick<SigninScreen, 'services' | 'bootstrapTokenPath'>

/**
 * What the daemons are doing and where the bootstrap token file is (phase 6,
 * F6b) are true of the host, not of the token that was just typed: a refused
 * token changes neither, so both ride along through the attempt. Picked by
 * name so an absent field stays absent (`exactOptionalPropertyTypes`).
 */
function hostFactsOf(screen: SigninScreen): CarriedHostFacts {
  return {
    ...(screen.services !== undefined ? { services: screen.services } : {}),
    ...bootstrapFactOf(screen),
  }
}

function bootstrapFactOf(screen: SigninScreen): Pick<SigninScreen, 'bootstrapTokenPath'> {
  const path = screen.bootstrapTokenPath
  return path !== undefined ? { bootstrapTokenPath: path } : {}
}

function applyKey(model: Model, screen: SigninScreen, key: KeyEvent): Step {
  if (key.kind === 'escape') return quit(model, EXIT_OK)
  // One sign-in at a time: a second Enter while the store is answering would queue a second lookup.
  if (key.kind === 'enter') return screen.busy ? noEffects(model) : submitToken(model, screen)

  const form = editFocused(screen.form, key)
  return form === screen.form ? noEffects(model) : withScreen(model, { ...screen, form })
}

/**
 * Hands the typed token to the runtime, or asks for one.
 *
 * The value is taken EXACTLY as typed — no trimming: an admin token is opaque,
 * and silently dropping the spaces around a pasted one would turn a wrong
 * paste into a wrong answer instead of a failed sign-in.
 */
function submitToken(model: Model, screen: SigninScreen): Step {
  const token = tokenOf(screen.form)
  if (token === '') return withScreen(model, { ...screen, notice: EMPTY_TOKEN_NOTICE })

  return withScreen(
    model,
    { kind: 'signin', form: clearSecrets(screen.form), busy: true, ...hostFactsOf(screen) },
    [{ kind: 'signin', token }],
  )
}

/** The sign-in form carries exactly one field (`SIGNIN_FIELDS`): the token. */
function tokenOf(form: Form): string {
  return form.fields[0]?.value ?? ''
}

function applyResult(model: Model, screen: SigninScreen, result: TokenAdmin): Step {
  if (result.kind === 'ok') {
    const session = { adminName: result.name, role: result.role }
    // The install decides what the catalogue may offer at all: under an
    // external supervisor `start` and `stop` are not this console's to run.
    const sections = visibleSections(result.role, SECTIONS, model.install ?? DEFAULT_INSTALL_FACTS)
    return withScreen(model, mainScreenOf(session, sections), [
      { kind: 'refresh-services' },
    ])
  }

  // A token that never existed and one that was rotated are the same sentence:
  // the console is local and under the same uid as the store, but a screen
  // that told them apart would be an oracle for no gain to the operator.
  const notice = result.kind === 'unreadable' ? result.detail : SIGNIN_UNKNOWN_TOKEN_NOTICE
  return withScreen(model, {
    kind: 'signin',
    form: screen.form,
    busy: false,
    notice,
    ...hostFactsOf(screen),
  })
}

/**
 * A fresh sign-in screen carrying a notice — what a lost session returns to.
 * Built from `initialModel` so the empty form has exactly one definition.
 */
export function signedOut(size: TerminalSize, notice: string, install?: InstallFacts): Model {
  const fresh = initialModel(size)
  // `initialModel` always opens on the sign-in screen; the guard says so to
  // the compiler rather than asserting it away.
  if (fresh.screen.kind !== 'signin') return fresh

  // What kind of install this is outlives every session on it, so it is
  // carried over rather than re-derived from a config the reducer cannot read.
  return {
    ...fresh,
    ...(install !== undefined ? { install } : {}),
    screen: { ...fresh.screen, notice },
  }
}
