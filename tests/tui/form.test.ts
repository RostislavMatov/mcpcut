import { describe, expect, test } from 'vitest'
import { ADMIN_NAME_PATTERN, ADMIN_ROLES } from '../../src/admin/constants.js'
import {
  clearSecrets,
  editFocused,
  focusNext,
  focusPrevious,
  formOf,
  isValid,
  validateForm,
  valuesOf,
  type FieldSpec,
  type Form,
} from '../../src/tui/form.js'
import type { KeyEvent } from '../../src/tui/keys.js'

/**
 * The console's form (phase 2, Task 5): four field kinds, pure reducers, and
 * not one mutation. Every action of the catalogue collects its arguments
 * through this module, so what it does with a keystroke IS the console's
 * editing behaviour — a letter must not disturb a choice, and a validated
 * form must put the focus where the operator has to look.
 */

const nameField: FieldSpec = {
  name: 'name',
  label: 'Name',
  kind: 'text',
  required: true,
  hint: ADMIN_NAME_PATTERN.source,
  validate: (value) =>
    ADMIN_NAME_PATTERN.test(value) ? undefined : `must match ${ADMIN_NAME_PATTERN.source}`,
}

const roleField: FieldSpec = {
  name: 'role',
  label: 'Role',
  kind: 'choice',
  options: ADMIN_ROLES,
}

const tokenField: FieldSpec = { name: 'token', label: 'Token', kind: 'secret' }

const forceField: FieldSpec = { name: 'force', label: 'Force', kind: 'flag' }

/** A form of all four kinds, and no function property — so it can be cloned. */
const CLONEABLE_SPECS: readonly FieldSpec[] = [
  { name: 'name', label: 'Name', kind: 'text', required: true },
  tokenField,
  roleField,
  forceField,
]

function char(value: string): KeyEvent {
  return { kind: 'char', char: value }
}

/** Types a whole string one keystroke at a time, as the runtime does. */
function type(form: Form, text: string): Form {
  return [...text].reduce((current, letter) => editFocused(current, char(letter)), form)
}

describe('formOf', () => {
  test('gives every field kind its starting value and focuses the first', () => {
    // Act
    const form = formOf([nameField, roleField, tokenField, forceField])

    // Assert
    expect(valuesOf(form)).toEqual({ name: '', role: 'owner', token: '', force: 'false' })
    expect(form.focus).toBe(0)
    expect(form.fields.map((field) => field.error)).toEqual([undefined, undefined, undefined, undefined])
  })

  test('an explicit initial wins over the kind default', () => {
    // Arrange
    const specs: readonly FieldSpec[] = [
      { ...roleField, initial: 'operator' },
      { ...forceField, initial: 'true' },
      { name: 'dir', label: 'Dir', kind: 'text', initial: '/srv' },
    ]

    // Act
    const form = formOf(specs)

    // Assert
    expect(valuesOf(form)).toEqual({ role: 'operator', force: 'true', dir: '/srv' })
  })

  test('a choice with no options at all still has a value', () => {
    // Act
    const form = formOf([{ name: 'empty', label: 'Empty', kind: 'choice' }])

    // Assert
    expect(valuesOf(form)).toEqual({ empty: '' })
  })
})

describe('editFocused', () => {
  test('typing appends to a text field', () => {
    // Arrange
    const form = formOf([nameField, roleField])

    // Act
    const typed = type(form, 'bob')

    // Assert
    expect(valuesOf(typed)).toEqual({ name: 'bob', role: 'owner' })
  })

  test('typing appends to a secret field like any other text', () => {
    // Arrange
    const form = formOf([tokenField])

    // Act
    const typed = type(form, 'mcpa_x')

    // Assert
    expect(valuesOf(typed)).toEqual({ token: 'mcpa_x' })
  })

  test('a space is a character, not a command', () => {
    // Arrange
    const form = type(formOf([nameField]), 'bo')

    // Act
    const typed = editFocused(form, char(' '))

    // Assert
    expect(valuesOf(typed)).toEqual({ name: 'bo ' })
  })

  test('backspace drops the last character', () => {
    // Arrange
    const form = type(formOf([nameField]), 'bob')

    // Act
    const shorter = editFocused(form, { kind: 'backspace' })

    // Assert
    expect(valuesOf(shorter)).toEqual({ name: 'bo' })
  })

  test('backspace on an empty field changes nothing', () => {
    // Arrange
    const form = formOf([nameField])

    // Act
    const same = editFocused(form, { kind: 'backspace' })

    // Assert
    expect(same).toBe(form)
  })

  test('edits land on the focused field only', () => {
    // Arrange
    const form = focusNext(formOf([nameField, { name: 'note', label: 'Note', kind: 'text' }]))

    // Act
    const typed = type(form, 'hi')

    // Assert
    expect(valuesOf(typed)).toEqual({ name: '', note: 'hi' })
  })

  test('the arrows cycle a choice forward and wrap around', () => {
    // Arrange
    const form = focusNext(formOf([nameField, roleField]))

    // Act
    const walked = [1, 2, 3].map((steps) =>
      Array.from({ length: steps }).reduce<Form>(
        (current) => editFocused(current, { kind: 'right' }),
        form,
      ),
    )

    // Assert — owner → operator → viewer → owner again
    expect(walked.map((each) => valuesOf(each).role)).toEqual(['operator', 'viewer', 'owner'])
  })

  test('the left arrow cycles a choice backwards from the first option', () => {
    // Arrange
    const form = focusNext(formOf([nameField, roleField]))

    // Act
    const back = editFocused(form, { kind: 'left' })

    // Assert
    expect(valuesOf(back).role).toBe('viewer')
  })

  test('a letter never disturbs a choice', () => {
    // Arrange
    const form = focusNext(formOf([nameField, roleField]))

    // Act
    const same = editFocused(form, char('v'))

    // Assert
    expect(same).toBe(form)
    expect(valuesOf(same).role).toBe('owner')
  })

  test('a space toggles a flag, and toggles it back', () => {
    // Arrange
    const form = formOf([forceField])

    // Act
    const on = editFocused(form, char(' '))
    const off = editFocused(on, char(' '))

    // Assert
    expect(valuesOf(on)).toEqual({ force: 'true' })
    expect(valuesOf(off)).toEqual({ force: 'false' })
  })

  test.each([{ kind: 'left' }, { kind: 'right' }] as const)(
    'the $kind arrow toggles a flag too',
    (key) => {
      // Arrange
      const form = formOf([forceField])

      // Act
      const toggled = editFocused(form, key)

      // Assert
      expect(valuesOf(toggled)).toEqual({ force: 'true' })
    },
  )

  test('a letter never toggles a flag', () => {
    // Arrange
    const form = formOf([forceField])

    // Act
    const same = editFocused(form, char('y'))

    // Assert
    expect(same).toBe(form)
  })

  test('a key the form has no use for leaves it alone', () => {
    // Arrange
    const form = type(formOf([nameField]), 'bob')

    // Act
    const same = editFocused(form, { kind: 'pagedown' })

    // Assert
    expect(same).toBe(form)
  })

  test('a form without fields survives every keystroke', () => {
    // Arrange
    const form = formOf([])

    // Act & Assert
    expect(editFocused(form, char('a'))).toBe(form)
    expect(focusNext(form)).toBe(form)
    expect(focusPrevious(form)).toBe(form)
  })
})

describe('focus', () => {
  test('moves forward and wraps to the first field', () => {
    // Arrange
    const form = formOf([nameField, roleField, tokenField])

    // Act
    const walked = [focusNext(form), focusNext(focusNext(form)), focusNext(focusNext(focusNext(form)))]

    // Assert
    expect(walked.map((each) => each.focus)).toEqual([1, 2, 0])
  })

  test('moves backwards and wraps to the last field', () => {
    // Arrange
    const form = formOf([nameField, roleField, tokenField])

    // Act
    const back = focusPrevious(form)

    // Assert
    expect(back.focus).toBe(2)
    expect(focusPrevious(back).focus).toBe(1)
  })
})

describe('validateForm', () => {
  test('an empty required field reads as required', () => {
    // Arrange
    const form = formOf([nameField, roleField])

    // Act
    const validated = validateForm(form)

    // Assert
    expect(validated.fields[0]?.error).toBe('required')
    expect(validated.fields[1]?.error).toBeUndefined()
    expect(isValid(validated)).toBe(false)
  })

  test('a value that fails its own check carries the check as the message', () => {
    // Arrange
    const form = type(formOf([nameField]), 'Bad Name')

    // Act
    const validated = validateForm(form)

    // Assert
    expect(validated.fields[0]?.error).toBe(`must match ${ADMIN_NAME_PATTERN.source}`)
  })

  test('the focus moves to the first field with an error', () => {
    // Arrange — the operator is on the last field, the mistake is on the second
    const specs: readonly FieldSpec[] = [
      { name: 'first', label: 'First', kind: 'text', initial: 'ok' },
      nameField,
      roleField,
    ]
    const form = { ...formOf(specs), focus: 2 }

    // Act
    const validated = validateForm(form)

    // Assert
    expect(validated.focus).toBe(1)
  })

  test('a valid form keeps the focus where it was and reports no error', () => {
    // Arrange
    const form = focusNext(validateForm(type(formOf([nameField, roleField]), 'bob')))

    // Act
    const validated = validateForm(form)

    // Assert
    expect(validated.focus).toBe(1)
    expect(validated.fields.map((field) => field.error)).toEqual([undefined, undefined])
    expect(isValid(validated)).toBe(true)
  })

  test('every error is recomputed, so a fixed field stops complaining', () => {
    // Arrange
    const complaining = validateForm(formOf([nameField]))
    expect(complaining.fields[0]?.error).toBe('required')

    // Act
    const validated = validateForm(type(complaining, 'bob'))

    // Assert
    expect(validated.fields[0]?.error).toBeUndefined()
    expect(isValid(validated)).toBe(true)
  })

  test('a fresh form is valid until it is asked', () => {
    // Act & Assert — `isValid` reports the last verdict, it does not compute one
    expect(isValid(formOf([nameField]))).toBe(true)
  })
})

describe('valuesOf', () => {
  test('maps every field name to its current value', () => {
    // Arrange
    const form = type(formOf([nameField, roleField, tokenField, forceField]), 'bob')

    // Act
    const values = valuesOf(editFocused(focusNext(form), { kind: 'right' }))

    // Assert
    expect(values).toEqual({ name: 'bob', role: 'operator', token: '', force: 'false' })
  })
})

describe('clearSecrets', () => {
  test('empties every secret and leaves the rest untouched', () => {
    // Arrange
    const form = type(formOf([tokenField, nameField]), 'mcpa_secret')

    // Act
    const cleared = clearSecrets(focusNext(form))

    // Assert
    expect(valuesOf(cleared)).toEqual({ token: '', name: '' })
    expect(cleared.focus).toBe(1)
    expect(JSON.stringify(cleared.fields.map((field) => field.value))).not.toContain('mcpa_')
  })

  test('a form with nothing secret in it is left as it is', () => {
    // Arrange
    const form = type(formOf([nameField]), 'bob')

    // Act & Assert
    expect(valuesOf(clearSecrets(form))).toEqual({ name: 'bob' })
  })
})

describe('immutability', () => {
  test('no reducer touches the form it was given', () => {
    // Arrange
    const form = type(formOf(CLONEABLE_SPECS), 'bob')
    const before = structuredClone(form)

    // Act — every reducer, each on the same input
    const reducers: ReadonlyArray<(input: Form) => Form> = [
      (input) => editFocused(input, char('x')),
      (input) => editFocused(input, { kind: 'backspace' }),
      (input) => editFocused(focusNext(focusNext(input)), { kind: 'right' }),
      (input) => editFocused(focusPrevious(input), char(' ')),
      focusNext,
      focusPrevious,
      validateForm,
      clearSecrets,
    ]

    // Assert
    for (const reducer of reducers) {
      const result = reducer(form)
      expect(form).toEqual(before)
      expect(result).not.toBe(form)
    }
    expect(form).toEqual(before)
  })
})

describe('editFocused: a stale verdict', () => {
  test('an edit clears the error the last validation left on the field', () => {
    const invalid = validateForm(formOf([{ name: 'n', label: 'N', kind: 'text', required: true }]))
    expect(invalid.fields[0]?.error).toBe('required')

    const edited = editFocused(invalid, char('a'))

    expect(edited.fields[0]?.value).toBe('a')
    expect(edited.fields[0]?.error).toBeUndefined()
  })
})
