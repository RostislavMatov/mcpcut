import { visibleActions } from './catalogue/index.js'
import type { ActionSpec } from './catalogue/types.js'
import { SECRET_DISPLAY_MASK } from './constants.js'
import { applyFormKey, type FormValues, isValid, validateForm, valuesOf } from './form.js'
import type { KeyEvent } from './keys.js'
import type { Effect, Model, Pane, RunRequest, Step } from './model.js'
import { ACTIONS_PANE, type MainScreen, noEffects, withMain } from './update-step.js'

/**
 * The two panes that stand between a chosen action and a running command
 * (mcpcut phase 2, Task 9): the form that collects its arguments, and the
 * question some actions ask before anything happens.
 *
 * `submit` is the ONLY place a `RunRequest` is built, and it is shared with
 * the action list (an action with no fields runs straight from `Enter`, and
 * `r` reruns a section's refresh action). One builder means the command line
 * the output pane prints is by construction the command line that ran.
 */

export type FormPane = Extract<Pane, { kind: 'form' }>
export type ConfirmPane = Extract<Pane, { kind: 'confirm' }>

/** The answers that mean yes at a confirmation. */
const YES_ANSWERS: readonly string[] = ['y', 'Y']

/** Whether a keystroke answers a question with yes; anything else is no. */
export function isYes(key: KeyEvent): boolean {
  return key.kind === 'char' && YES_ANSWERS.includes(key.char)
}

/**
 * Turns an action and the values it was given into the request the runtime
 * dispatches.
 *
 * `display` is a COPY of `argv` with every secret argument replaced by
 * `SECRET_DISPLAY_MASK`: the panel prints the copy beside the output, and the
 * original is what actually ran. Both are needed — a masked argv would be a
 * lie about the command, and an unmasked display would put a token on screen
 * for as long as its output stays there.
 *
 * `stdoutPath` is spread in only when the action names an output field that
 * was filled: `exactOptionalPropertyTypes` is on, so an absent path is an
 * absent key rather than an `undefined` one. `reopen` and `mintsToken` ride
 * along the same way — both are facts about the ACTION that the runtime and
 * the output pane need after the argv has left the catalogue behind.
 *
 * Every NON-secret value is trimmed before either is built. A field is typed
 * into and pasted into, and the padding that survives is nobody's argument:
 * a server named `" github"` is not the registered one, and a path of
 * `" /tmp/out "` is a file with spaces in its name. A SECRET is handed over
 * exactly as typed — leading or trailing whitespace can be part of the value,
 * and this is not the place to decide it is not.
 */
export function requestOf(action: ActionSpec, values: FormValues): RunRequest {
  const trimmed = trimmedValuesOf(action, values)
  const argv = action.argv(trimmed)
  const secrets = secretValuesOf(action, trimmed)
  const display = argv.map((arg) => (secrets.has(arg) ? SECRET_DISPLAY_MASK : arg))
  const stdoutPath = action.stdoutToField === undefined ? '' : (trimmed[action.stdoutToField] ?? '')

  return {
    actionId: action.id,
    argv,
    display,
    ...(stdoutPath === '' ? {} : { stdoutPath }),
    ...(action.leavesConsole === true ? { reopen: true as const } : {}),
    ...(action.mintsToken === true ? { mintsToken: true as const } : {}),
  }
}

/**
 * The effect a request asks for. A `reopen` request is not dispatched at all:
 * the console ends and the argv runs as a child on the same terminal, because
 * a console already serving the old catalogue cannot honestly host the wizard
 * that rewrites the install underneath it (ADR-0012 §16, plan P4).
 */
export function effectOf(request: RunRequest, stdin?: string): Effect {
  if (request.reopen === true) return { kind: 'reopen', argv: request.argv }

  return { kind: 'run', request, ...(stdin === undefined ? {} : { stdin }) }
}

/** The values with every non-secret one trimmed; the secrets pass through untouched. */
function trimmedValuesOf(action: ActionSpec, values: FormValues): FormValues {
  const secretNames = new Set(
    action.fields.filter((field) => field.kind === 'secret').map((field) => field.name),
  )

  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      secretNames.has(name) ? value : value.trim(),
    ]),
  )
}

/**
 * What the action's `secret` fields hold, empty values excluded. An empty
 * secret must not join the set: `''` matches every empty argument an `argv`
 * builder emits, and the whole command line would come out masked.
 */
function secretValuesOf(action: ActionSpec, values: FormValues): ReadonlySet<string> {
  const secrets = action.fields
    .filter((field) => field.kind === 'secret')
    .map((field) => values[field.name] ?? '')

  return new Set(secrets.filter((value) => value !== ''))
}

/**
 * The value the command reads from stdin, when the action names such a field.
 *
 * An action that declares `stdinField` ALWAYS gets a string — the empty one if
 * the form somehow left the field out — because the alternative is a command
 * left reading the console's own stdin. `undefined` means "this action wants
 * nothing written to it", and nothing else.
 */
export function stdinOf(action: ActionSpec, values: FormValues): string | undefined {
  return action.stdinField === undefined ? undefined : (values[action.stdinField] ?? '')
}

/** Runs an action, or asks the question it insists on first. */
export function submit(
  model: Model,
  screen: MainScreen,
  action: ActionSpec,
  values: FormValues,
): Step {
  const request = requestOf(action, values)
  // An action may ask conditionally: `confirm` returning `undefined` for these
  // values means the operator already answered on the form (`prune --yes`).
  const question = action.confirm?.(values)
  if (question !== undefined) {
    const pane: Pane = { kind: 'confirm', actionId: action.id, request, question }
    return withMain(model, screen, { pane })
  }

  // A request that leaves the console never sets `busy`: nothing is running
  // here to wait for, and a screen frozen on a run that will never answer is
  // the last thing the operator would see.
  if (request.reopen === true) {
    return withMain(model, screen, { pane: ACTIONS_PANE }, [effectOf(request)])
  }

  // The secret rides on the EFFECT, which the runtime consumes and drops;
  // `busy` keeps the request, and a request is part of the model.
  const stdin = stdinOf(action, values)
  return withMain(model, screen, { pane: ACTIONS_PANE, busy: request }, [
    effectOf(request, stdin),
  ])
}

/** Folds one keystroke into an open form. */
export function updateFormPane(
  model: Model,
  screen: MainScreen,
  pane: FormPane,
  key: KeyEvent,
): Step {
  if (key.kind === 'escape') return withMain(model, screen, { pane: ACTIONS_PANE })
  if (key.kind === 'enter') return runForm(model, screen, pane)

  const form = applyFormKey(pane.form, key)
  return form === pane.form ? noEffects(model) : withMain(model, screen, { pane: { ...pane, form } })
}

/**
 * Validates the whole form and either shows what is wrong with it or runs it.
 * The action is looked up by the id the pane carries rather than by the
 * cursor, so a form always builds the command it was opened for.
 */
function runForm(model: Model, screen: MainScreen, pane: FormPane): Step {
  const action = actionOf(screen, pane.actionId)
  if (action === undefined) return withMain(model, screen, { pane: ACTIONS_PANE })

  const form = validateForm(pane.form)
  if (!isValid(form)) return withMain(model, screen, { pane: { ...pane, form } })

  return submit(model, screen, action, valuesOf(form))
}

function actionOf(screen: MainScreen, actionId: string): ActionSpec | undefined {
  const section = screen.sections[screen.sectionIndex]
  if (section === undefined) return undefined

  return visibleActions(section, screen.session.role).find((action) => action.id === actionId)
}

/** Folds one keystroke into a confirmation: yes runs it, anything else cancels. */
export function updateConfirmPane(
  model: Model,
  screen: MainScreen,
  pane: ConfirmPane,
  key: KeyEvent,
): Step {
  if (!isYes(key)) return withMain(model, screen, { pane: ACTIONS_PANE })
  if (pane.request.reopen === true) {
    return withMain(model, screen, { pane: ACTIONS_PANE }, [effectOf(pane.request)])
  }

  return withMain(model, screen, { pane: ACTIONS_PANE, busy: pane.request }, [
    effectOf(pane.request),
  ])
}
