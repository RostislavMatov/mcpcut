import type { KeyEvent } from './keys.js'

/**
 * Forms of the console (mcpcut phase 2, Task 5): the four field kinds every
 * catalogue action collects its arguments with, and the pure reducers that
 * edit them.
 *
 * Nothing here touches a terminal or a store — a form is data, a keystroke is
 * data, and every function returns a NEW form (the `withAdmin` discipline of
 * `src/admin/store.ts`). That is what lets the sign-in screen and the action
 * panes share one editor, and what lets `clearSecrets` be a guarantee rather
 * than a hope: the token typed on the sign-in screen leaves the model by
 * being replaced, never by being overwritten in place.
 */

/** What a field holds and how a keystroke changes it. */
export type FieldKind = 'text' | 'secret' | 'choice' | 'flag'

/** The declaration of one field, written by the catalogue. */
export interface FieldSpec {
  /** Key under which the value reaches `argv` builders (`valuesOf`). */
  readonly name: string
  /** Label as the pane prints it. */
  readonly label: string
  readonly kind: FieldKind
  /** The closed list of a `choice`; ignored by the other kinds. */
  readonly options?: readonly string[]
  /** An empty value fails validation when true. */
  readonly required?: boolean
  /** Starting value; wins over the default of the kind. */
  readonly initial?: string
  /** Shown beside the field — the accepted shape, not an error. */
  readonly hint?: string
  /** Extra check for a non-empty value; the message becomes the field error. */
  readonly validate?: (value: string) => string | undefined
}

/**
 * One field as it currently stands. A `flag` holds `'true'` or `'false'` and
 * a `choice` holds one of its options, so a form is always a flat map of
 * strings and an action builds `argv` without a second vocabulary.
 */
export interface FieldState {
  readonly spec: FieldSpec
  readonly value: string
  /** Set by `validateForm` only; absent means "not known to be wrong". */
  readonly error?: string
}

/** A form is its fields plus which one has the focus. */
export interface Form {
  readonly fields: readonly FieldState[]
  readonly focus: number
}

/** Field values by field name, as an action's `argv` builder reads them. */
export type FormValues = Readonly<Record<string, string>>

/** The two values a `flag` field can hold. */
const FLAG_ON = 'true'
const FLAG_OFF = 'false'

/** Error of an empty field that must not be empty. */
const REQUIRED_ERROR = 'required'

/** Builds the starting form of a declaration: values by kind, focus first. */
export function formOf(specs: readonly FieldSpec[]): Form {
  return { fields: specs.map((spec) => ({ spec, value: initialValueOf(spec) })), focus: 0 }
}

function initialValueOf(spec: FieldSpec): string {
  if (spec.initial !== undefined) return spec.initial
  if (spec.kind === 'flag') return FLAG_OFF
  if (spec.kind === 'choice') return spec.options?.[0] ?? ''
  return ''
}

/** Moves the focus one field down, wrapping past the last one. */
export function focusNext(form: Form): Form {
  return movedFocus(form, 1)
}

/** Moves the focus one field up, wrapping past the first one. */
export function focusPrevious(form: Form): Form {
  return movedFocus(form, -1)
}

function movedFocus(form: Form, delta: number): Form {
  const count = form.fields.length
  if (count === 0) return form

  const focus = (form.focus + delta + count) % count
  return focus === form.focus ? form : { ...form, focus }
}

/**
 * Applies one keystroke to the focused field. A key the field has no use for
 * — a letter on a `choice`, an arrow on a text field — returns the very same
 * form, so a caller can tell "nothing happened" by identity.
 */
export function editFocused(form: Form, key: KeyEvent): Form {
  const field = form.fields[form.focus]
  if (field === undefined) return form

  const edited = editField(field, key)
  if (edited === field) return form

  return { ...form, fields: form.fields.map((each, index) => (index === form.focus ? edited : each)) }
}

/**
 * The whole key rule of a form, in one place: the focus keys move the focus,
 * and every other keystroke is the focused field's business. Both screens that
 * show a form fold their keys through this, so `Tab` means the same thing on
 * the wizard as it does on an action pane. Like `editFocused`, a key that
 * changed nothing returns the very same form.
 */
export function applyFormKey(form: Form, key: KeyEvent): Form {
  if (key.kind === 'tab' || key.kind === 'down') return focusNext(form)
  if (key.kind === 'backtab' || key.kind === 'up') return focusPrevious(form)

  return editFocused(form, key)
}

function editField(field: FieldState, key: KeyEvent): FieldState {
  switch (field.spec.kind) {
    case 'text':
    case 'secret':
      return editedText(field, key)
    case 'choice':
      return editedChoice(field, key)
    case 'flag':
      return editedFlag(field, key)
  }
}

function editedText(field: FieldState, key: KeyEvent): FieldState {
  if (key.kind === 'char') return withValue(field, field.value + key.char)
  if (key.kind === 'backspace' && field.value !== '') return withValue(field, field.value.slice(0, -1))
  return field
}

function editedChoice(field: FieldState, key: KeyEvent): FieldState {
  const step = stepOf(key)
  const options = field.spec.options ?? []
  if (step === 0 || options.length === 0) return field

  // A value outside the list (an `initial` the catalogue got wrong) counts as
  // the first option, so an arrow always lands on something selectable.
  const current = options.indexOf(field.value)
  const next = options[((current === -1 ? 0 : current) + step + options.length) % options.length]
  return next === undefined || next === field.value ? field : withValue(field, next)
}

function editedFlag(field: FieldState, key: KeyEvent): FieldState {
  const toggles = stepOf(key) !== 0 || (key.kind === 'char' && key.char === ' ')
  if (!toggles) return field

  return withValue(field, field.value === FLAG_ON ? FLAG_OFF : FLAG_ON)
}

/** Direction of a horizontal key: right +1, left -1, anything else 0. */
function stepOf(key: KeyEvent): number {
  if (key.kind === 'right') return 1
  if (key.kind === 'left') return -1
  return 0
}

/** A new value has not been validated yet, so the old verdict goes with the old value. */
function withValue(field: FieldState, value: string): FieldState {
  return { spec: field.spec, value }
}

/**
 * Recomputes EVERY error and puts the focus on the first field that has one
 * (or leaves it where it was, when the form is good). Recomputing the lot is
 * both simpler and honester than patching the field that was touched: the
 * verdict a pane shows always describes the values it shows.
 */
export function validateForm(form: Form): Form {
  const fields = form.fields.map(validatedField)
  const firstError = fields.findIndex((field) => field.error !== undefined)

  return { fields, focus: firstError === -1 ? form.focus : firstError }
}

function validatedField(field: FieldState): FieldState {
  const error = errorOf(field)
  if (error === undefined) return field.error === undefined ? field : { spec: field.spec, value: field.value }

  return { spec: field.spec, value: field.value, error }
}

function errorOf(field: FieldState): string | undefined {
  const { spec, value } = field
  if (spec.required === true && value === '') return REQUIRED_ERROR

  return spec.validate?.(value)
}

/** True when no field carries an error from the last `validateForm`. */
export function isValid(form: Form): boolean {
  return form.fields.every((field) => field.error === undefined)
}

/** The form as a flat map, ready for an action's `argv` builder. */
export function valuesOf(form: Form): FormValues {
  return Object.fromEntries(form.fields.map((field) => [field.spec.name, field.value]))
}

/**
 * Empties every `secret` field. Called the moment a secret has been handed to
 * the effect that needs it: the model must not be the second place a token
 * lives (ADR-0004 — never in a frame).
 */
export function clearSecrets(form: Form): Form {
  return {
    ...form,
    fields: form.fields.map((field) =>
      field.spec.kind === 'secret' && field.value !== '' ? withValue(field, '') : field,
    ),
  }
}
