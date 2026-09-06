import type { TokenAdmin } from '../cli/admin-token.js'
import { visibleSections } from './catalogue/index.js'
import { EXIT_OK, SIGNIN_UNKNOWN_TOKEN_NOTICE } from './constants.js'
import { clearSecrets, editFocused, type Form } from './form.js'
import type { KeyEvent } from './keys.js'
import { initialModel, mainScreenOf, type Model, type Msg, type Screen, type Step, type TerminalSize } from './model.js'
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
 * The screen also ignores `run-result` and `services`. Both are answers to a
 * session that has already ended (`session-lost` races an effect that was
 * already in flight), and folding them in would put a dead session's output on
 * the screen of whoever signs in next.
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

  // `run-result`, `services` and a second `session-lost` belong to a session
  // that is already over; `resize` never reaches here (`update.ts` takes it).
  return noEffects(model)
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

  return withScreen(model, { kind: 'signin', form: clearSecrets(screen.form), busy: true }, [
    { kind: 'signin', token },
  ])
}

/** The sign-in form carries exactly one field (`SIGNIN_FIELDS`): the token. */
function tokenOf(form: Form): string {
  return form.fields[0]?.value ?? ''
}

function applyResult(model: Model, screen: SigninScreen, result: TokenAdmin): Step {
  if (result.kind === 'ok') {
    const session = { adminName: result.name, role: result.role }
    return withScreen(model, mainScreenOf(session, visibleSections(result.role)), [
      { kind: 'refresh-services' },
    ])
  }

  // A token that never existed and one that was rotated are the same sentence:
  // the console is local and under the same uid as the store, but a screen
  // that told them apart would be an oracle for no gain to the operator.
  const notice = result.kind === 'unreadable' ? result.detail : SIGNIN_UNKNOWN_TOKEN_NOTICE
  return withScreen(model, { kind: 'signin', form: screen.form, busy: false, notice })
}

/**
 * A fresh sign-in screen carrying a notice — what a lost session returns to.
 * Built from `initialModel` so the empty form has exactly one definition.
 */
export function signedOut(size: TerminalSize, notice: string): Model {
  const fresh = initialModel(size)
  // `initialModel` always opens on the sign-in screen; the guard says so to
  // the compiler rather than asserting it away.
  if (fresh.screen.kind !== 'signin') return fresh

  return { ...fresh, screen: { ...fresh.screen, notice } }
}
