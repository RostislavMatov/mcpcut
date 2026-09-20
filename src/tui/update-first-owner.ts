import { ADMIN_NAME_PATTERN } from '../admin/constants.js'
import { EXIT_OK } from './constants.js'
import { FIRST_OWNER_CODE_LABEL, FIRST_OWNER_NAME_LABEL, REMOTE_AUDIT_RECORD_DROPPED_WARNING } from './constants-live.js'
import { applyFormKey, clearSecrets, formOf, isValid, valuesOf, validateForm, type FieldSpec, type Form } from './form.js'
import type { KeyEvent } from './keys.js'
import {
  DEFAULT_INSTALL_FACTS,
  SIGNIN_FIELDS,
  type FirstOwnerRemoteOutcome,
  type FirstOwnerScreen,
  type FirstOwnerStage,
  type InstallFacts,
  type Model,
  type Msg,
  type RunRequest,
  type Step,
  type TerminalSize,
} from './model.js'
import type { RunResult } from './output.js'
import { isYes } from './update-form.js'
import { disconnectStep, isDisconnectKey, isRemoteInstall, noEffects, quit, withScreen } from './update-step.js'
import { mintedAdminOf, MINTED_ADMIN_PREFIX, MINTED_TOKEN_PREFIX } from './wizard-fields.js'

/**
 * The first-owner screen (2026-09-19): what the console opens on when the
 * install has no admin, instead of a sign-in screen nobody holds a token for.
 *
 * The web console asks for a setup code here (`ui/setup-flow.ts`); this one
 * did not, at first, and the difference was the threat model, not a shortcut:
 * a LOCAL console runs under the service's uid, which already reads and
 * writes the store directly (ADR-0012 §19, ADR-0004 "same uid"). What it runs
 * is the CLI's own bootstrap — `admin add <name> --role owner` with NO token
 * in its environment, which the command accepts only while the store is empty
 * and journals with an unnamed actor. So the emptiness check that matters is
 * the command's, made inside the store's update; the console's own look at
 * the store on opening only decides which screen to draw. Losing the race to
 * a shell is a refusal from the command, and the screen becomes the sign-in.
 *
 * A REMOTE console (ADR-0014, `--remote`) has no store to read directly and
 * no shared uid to trust: it is exactly the browser's own `/setup`, so it
 * asks for the same code and calls the same `POST setup` — with the code
 * masked like a token and cleared from the model the instant `Enter` hands it
 * to the effect (`clearSecrets`, the sign-in screen's own discipline). Both
 * paths converge on the SAME token-hold stage once an owner exists, because
 * `mintedAdminOf` is asked to parse a document built to look exactly like
 * `admin add`'s stdout — one parser, one hold screen, one `mintsToken`
 * code path, whichever install created the owner.
 *
 * The token is held the way the wizard holds it: on screen until `y`, `q`
 * asks first, and `y` signs in with it — at which point it leaves the model
 * for the effect and the token cell, like any typed token.
 */

type FormStage = Extract<FirstOwnerStage, { kind: 'form' }>
type HoldStage = Extract<FirstOwnerStage, { kind: 'hold' }>

const NAME_FIELD = 'name'
const CODE_FIELD = 'code'
const QUIT_CHAR = 'q'
const FIRST_OWNER_ACTION_ID = 'first-owner'

/** Shown on the sign-in screen when the command succeeded but its token could not be read back. */
export const FIRST_OWNER_FAILED_NOTICE =
  'The owner may exist, but its token was not read — in a shell: mcpcut admin rotate <name> --recover'

const NAME_FIELD_SPEC: FieldSpec = {
  name: NAME_FIELD,
  label: FIRST_OWNER_NAME_LABEL,
  kind: 'text',
  required: true,
  validate: (value) =>
    ADMIN_NAME_PATTERN.test(value.trim()) ? undefined : `must match ${ADMIN_NAME_PATTERN.source}`,
}

export const FIRST_OWNER_FIELDS: readonly FieldSpec[] = [NAME_FIELD_SPEC]

/**
 * The remote form (ADR-0014): the code first, exactly the order the `/setup`
 * page asks in, then the same name field a local console uses. `secret` so
 * the renderer masks it and `clearSecrets` empties it the moment `Enter` has
 * handed it to the effect — the code must never survive a submit in the model.
 */
export const REMOTE_FIRST_OWNER_FIELDS: readonly FieldSpec[] = [
  { name: CODE_FIELD, label: FIRST_OWNER_CODE_LABEL, kind: 'secret', required: true },
  NAME_FIELD_SPEC,
]

/** The model a console over an install with no admin opens with. */
export function firstOwnerModel(size: TerminalSize, install: InstallFacts = DEFAULT_INSTALL_FACTS): Model {
  const fields = install.remote === true ? REMOTE_FIRST_OWNER_FIELDS : FIRST_OWNER_FIELDS
  return {
    screen: { kind: 'first-owner', stage: { kind: 'form', form: formOf(fields), busy: false } },
    size,
    install,
  }
}

export function updateFirstOwner(model: Model, screen: FirstOwnerScreen, msg: Msg): Step {
  const { stage } = screen
  if (stage.kind === 'hold') return msg.kind === 'key' ? onHoldKey(model, stage, msg.key) : noEffects(model)
  if (msg.kind === 'key') return onFormKey(model, stage, msg.key)
  if (msg.kind === 'first-owner-result' && stage.busy) return onResult(model, msg.result)
  if (msg.kind === 'first-owner-setup-result' && stage.busy) return onRemoteResult(model, stage, msg.result)

  return noEffects(model)
}

function onFormKey(model: Model, stage: FormStage, key: KeyEvent): Step {
  // Busy comes FIRST, ahead of Esc: the command in flight is creating an
  // owner, and a console that left now would let it finish with nobody there
  // to be shown the only copy of its token. It also keeps a second Enter from
  // queueing a second `admin add`. Ctrl-C (`update.ts`) still leaves, as it
  // does during every other run.
  if (stage.busy) return noEffects(model)
  // Ctrl-D (2026-09-20, owner request "a way to disconnect"): remote-only,
  // and only on THIS stage — never `hold`, where the one-time token must not
  // be lost to a stray chord (`updateFirstOwner`'s own routing already keeps
  // this branch out of that stage). Locally the chord does nothing, exactly
  // as it always has: it falls through to the ordinary handling below, which
  // has no use for a Ctrl combination either.
  if (isDisconnectKey(key) && isRemoteInstall(model)) return disconnectStep(model)
  if (key.kind === 'escape') return quit(model, EXIT_OK)
  if (key.kind === 'enter') return submit(model, stage)

  // `applyFormKey`, not `editFocused` alone: the remote form has two fields
  // (code, name) and Tab must move between them. A one-field local form is
  // unaffected — `focusNext` on a single field returns the very same form.
  const form = applyFormKey(stage.form, key)
  return form === stage.form ? noEffects(model) : withStage(model, { ...stage, form })
}

function submit(model: Model, stage: FormStage): Step {
  const form = validateForm(stage.form)
  if (!isValid(form)) return withStage(model, { ...stage, form })

  return isRemoteInstall(model) ? submitRemote(model, stage, form) : submitLocal(model, stage, form)
}

function submitLocal(model: Model, stage: FormStage, form: Form): Step {
  const name = nameOf(form)
  const argv = ['admin', 'add', name, '--role', 'owner']
  const request: RunRequest = { actionId: FIRST_OWNER_ACTION_ID, argv, display: argv, mintsToken: true }
  return withScreen(model, { kind: 'first-owner', stage: { kind: 'form', form, busy: true } }, [
    { kind: 'first-owner-run', request },
  ])
}

function submitRemote(model: Model, stage: FormStage, form: Form): Step {
  const values = valuesOf(form)
  const code = values[CODE_FIELD] ?? ''
  const name = nameOf(form)
  // Cleared BEFORE it reaches the model this function returns: the code must
  // never survive a submit, in the model, in argv/`display`, or on a frame.
  const cleared = clearSecrets(form)
  return withScreen(model, { kind: 'first-owner', stage: { kind: 'form', form: cleared, busy: true } }, [
    { kind: 'first-owner-setup', code, name },
  ])
}

function nameOf(form: Form): string {
  return (valuesOf(form)[NAME_FIELD] ?? '').trim()
}

function onResult(model: Model, result: RunResult): Step {
  const admin = result.exitCode === 0 ? mintedAdminOf(result.stdout) : undefined
  if (admin !== undefined) return withStage(model, { kind: 'hold', admin, quitAsked: false })

  // Refused — most likely a shell created an admin first — or answered without
  // a token: either way the sign-in screen is where the operator belongs now.
  const notice = result.exitCode === 0 ? FIRST_OWNER_FAILED_NOTICE : firstLineOf(result.stderr)
  // `opened` — the sign-in screen's cue to ask about the daemons — was spent
  // on this screen, so the question goes out here instead.
  return { model: toSignin(model, false, notice).model, effects: [{ kind: 'refresh-services' }] }
}

/**
 * The remote answer (ADR-0014). `ok` is turned into the SAME document
 * `admin add` prints — `mintedAdminOf` parses it, so the hold stage and the
 * token-hold code path (`mintsToken`, `y` signs in, `q` asks) are one
 * definition whichever install minted the owner. `closed` (an admin now
 * exists — a race, or a shell won it) goes to the sign-in screen exactly as a
 * local refusal does; everything else the server said keeps the operator on
 * the form, already cleared of the code, with the message to read.
 */
function onRemoteResult(model: Model, stage: FormStage, result: FirstOwnerRemoteOutcome): Step {
  if (result.kind === 'closed') {
    return { model: toSignin(model, false).model, effects: [{ kind: 'refresh-services' }] }
  }
  if (result.kind === 'refused') {
    return withStage(model, { kind: 'form', form: stage.form, busy: false, notice: result.message })
  }

  const stdout = `${MINTED_ADMIN_PREFIX}${result.name}\n${MINTED_TOKEN_PREFIX}${result.token}\n`
  const admin = mintedAdminOf(stdout)
  if (admin === undefined) {
    return { model: toSignin(model, false, FIRST_OWNER_FAILED_NOTICE).model, effects: [{ kind: 'refresh-services' }] }
  }

  return withStage(model, {
    kind: 'hold',
    admin,
    quitAsked: false,
    ...(result.journaled ? {} : { warning: REMOTE_AUDIT_RECORD_DROPPED_WARNING }),
  })
}

function onHoldKey(model: Model, stage: HoldStage, key: KeyEvent): Step {
  if (stage.quitAsked) {
    return isYes(key) ? quit(model, EXIT_OK) : withStage(model, { ...stage, quitAsked: false })
  }
  if (isYes(key)) {
    const step = toSignin(model, true)
    return { model: step.model, effects: [{ kind: 'signin', token: stage.admin.token }] }
  }
  const isQuit = key.kind === 'escape' || (key.kind === 'char' && key.char === QUIT_CHAR)
  return isQuit ? withStage(model, { ...stage, quitAsked: true }) : noEffects(model)
}

function toSignin(model: Model, busy: boolean, notice?: string): Step {
  return withScreen(model, {
    kind: 'signin',
    form: formOf(SIGNIN_FIELDS),
    busy,
    ...(notice !== undefined && notice !== '' ? { notice } : {}),
  })
}

function withStage(model: Model, stage: FirstOwnerStage): Step {
  return withScreen(model, { kind: 'first-owner', stage })
}

function firstLineOf(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? FIRST_OWNER_FAILED_NOTICE
}
