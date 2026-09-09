import type { FieldSpec, FormValues } from '../form.js'

/**
 * The field constructors and argv fragments the sections share (mcpcut phase
 * 4, Task 3).
 *
 * Nine declarative sections build their command lines out of the same handful
 * of shapes: an optional flag, a switch, a bare positional, a flag repeated
 * once per comma-separated value, and a choice one of whose options means
 * "don't ask". Written once here they read the same way in every section, and
 * a fix to one of them is a fix everywhere.
 *
 * Every function is pure and returns a NEW array or object. That is the same
 * discipline `ActionSpec.argv` is held to (`tests/tui/catalogue.test.ts`): the
 * runtime keeps the argv it ran beside the output, so nothing may be shared
 * between two runs.
 *
 * IMPORT DISCIPLINE: `../form.js` for the field types, and nothing else. These
 * helpers must not learn what a store or a CLI flag parser thinks — a section
 * imports the CLI's own constants when it needs them and passes them in.
 */

/** The value of a field that a `choice` uses to say "leave the flag out". */
export const ANY_OPTION = 'any'

/** How a repeated flag's field separates its values. */
const LIST_SEPARATOR = ','

/** The two values a `flag` field holds; the form writes them, we read them. */
const FLAG_ON = 'true'

/**
 * One field's value. A form always carries every field it declared, so the
 * fallback is unreachable in a real form — it is here because an index into a
 * `Record` is `string | undefined` under `noUncheckedIndexedAccess`, and an
 * empty value is what an unfilled optional field means anyway.
 */
export function valueOf(values: FormValues, name: string): string {
  return values[name] ?? ''
}

/** Whether a `flag` field is on. */
export function isOn(values: FormValues, name: string): boolean {
  return valueOf(values, name) === FLAG_ON
}

/** `[flag, value]` when the field holds something, nothing otherwise. */
export function optionFlag(values: FormValues, name: string, flag: string): readonly string[] {
  const value = valueOf(values, name).trim()
  return value === '' ? [] : [flag, value]
}

/** `[flag]` when the flag field is on. */
export function switchFlag(values: FormValues, name: string, flag: string): readonly string[] {
  return isOn(values, name) ? [flag] : []
}

/** `[value]` when non-empty — an optional positional. */
export function positional(values: FormValues, name: string): readonly string[] {
  const value = valueOf(values, name).trim()
  return value === '' ? [] : [value]
}

/**
 * Splits on commas (trim, drop empties) and repeats the flag: `--env A=1
 * --env B=2`.
 *
 * Deliberately not a parser of what is between the commas: `A=1` and
 * `B=vault:x` are shapes the CLI knows and refuses in its own words, and a
 * second opinion here would be one that drifts.
 */
export function repeatedFlag(values: FormValues, name: string, flag: string): readonly string[] {
  return valueOf(values, name)
    .split(LIST_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .flatMap((part) => [flag, part])
}

/** `[flag, choice]`, unless the choice is `ANY_OPTION` — then the flag is omitted. */
export function choiceFlag(values: FormValues, name: string, flag: string): readonly string[] {
  const value = valueOf(values, name)
  return value === '' || value === ANY_OPTION ? [] : [flag, value]
}

/**
 * A choice whose first option means "not asked".
 *
 * `ANY_OPTION` rather than an empty string on purpose: a `choice` widget
 * prints its current value between arrows, and `‹  ›` reads as a broken
 * screen rather than as an answer.
 */
export function optionalChoice(
  name: string,
  label: string,
  options: readonly string[],
  hint?: string,
): FieldSpec {
  return {
    name,
    label,
    kind: 'choice',
    options: [ANY_OPTION, ...options],
    ...hintOf(hint),
  }
}

/** A line of text; optional unless the caller says otherwise. */
export function textField(name: string, label: string, hint?: string, required = false): FieldSpec {
  return { name, label, kind: 'text', required, ...hintOf(hint) }
}

/** A flag the operator turns on with space; off is its starting value. */
export function flagField(name: string, label: string, hint?: string): FieldSpec {
  return { name, label, kind: 'flag', ...hintOf(hint) }
}

/**
 * A required secret: the renderer masks it and `clearSecrets` empties it the
 * moment it has been handed to the effect that needs it.
 */
export function secretField(name: string, label: string, hint?: string): FieldSpec {
  return { name, label, kind: 'secret', required: true, ...hintOf(hint) }
}

/**
 * Required text validated by the same RegExp the store enforces; the hint is
 * the pattern's source, and so is the refusal — word for word what the
 * Admins section has said since phase 2.
 */
export function patternField(
  name: string,
  label: string,
  pattern: RegExp,
  hint: string = pattern.source,
): FieldSpec {
  return {
    name,
    label,
    kind: 'text',
    required: true,
    hint,
    validate: (value) => (pattern.test(value) ? undefined : `must match ${pattern.source}`),
  }
}

/**
 * The optional "narrow to one session" field, shared by the Journal and Audit
 * sections. One definition rather than two byte-identical ones: both sections
 * pass it to commands that read the same journal, and a hint reworded in one
 * of them would silently mean two different things on two screens.
 */
export const optionalSessionField: FieldSpec = textField(
  'session',
  'Session',
  'blank = the whole journal',
)

/**
 * The `hint` key, or no key at all. `exactOptionalPropertyTypes` is on, so an
 * absent hint must be an absent PROPERTY rather than one holding `undefined`.
 */
function hintOf(hint: string | undefined): { readonly hint?: string } {
  return hint === undefined ? {} : { hint }
}
