import { describe, expect, test } from 'vitest'
import { SECTIONS } from '../../src/tui/catalogue/index.js'
import type { ActionSpec, SectionSpec } from '../../src/tui/catalogue/types.js'
import {
  ACTION_COLUMN_WIDTH,
  ACTIVE_MARKER,
  COLUMN_GAP,
  DEFAULT_COLUMNS,
  FIELD_LABEL_MAX_WIDTH,
} from '../../src/tui/constants.js'
import type { FieldSpec, FormValues } from '../../src/tui/form.js'

/**
 * The invariants that hold over the WHOLE catalogue (mcpcut phase 4, Task
 * 10), rather than over the sections one task happened to write.
 *
 * The per-section files (`catalogue-servers`, `catalogue-access`,
 * `catalogue-journal`) say what each section means; this one says what no
 * section may do, whichever wave adds it. Three of the rules are properties
 * the console would otherwise lose quietly:
 *
 * - **A secret never reaches a command line.** Every field of every action is
 *   filled with a sentinel and every `argv` is searched for the secret one.
 *   `vault set` is the only action with a secret today; the test is written
 *   over all of them so that the twelfth section cannot introduce a second
 *   one that forgets `stdinField`. Half of that rule is now a type as well —
 *   `ActionSpec` is a union in which `stdinField` and `confirm` cannot both
 *   appear (owner tail Q23, pinned by `catalogue-types.test.ts`). The runtime
 *   test stays: it also checks that `stdinField` names a field that really is
 *   `secret`, and that no `argv` carries a secret's value, neither of which a
 *   type can say.
 * - **A section's refresh needs no form.** `r` re-runs `refreshActionId`
 *   without asking anything, so an action with fields there would run on
 *   blanks.
 * - **Everything fits 80 columns.** Titles fit the action column beside the
 *   marker, and intro lines and hints fit the pane beside it; a line that
 *   does not is cut by the renderer, which is how a hint loses the half that
 *   carried its warning.
 */

/** Every action of every section, regardless of role. */
const ALL_ACTIONS: readonly ActionSpec[] = SECTIONS.flatMap((section) => section.actions)

/** Longest title the action column can print beside its marker. */
const TITLE_MAX_WIDTH = ACTION_COLUMN_WIDTH - ACTIVE_MARKER.length

/**
 * The pane beside the action column, on the 80-column screen the layout is
 * written for: what an intro line or a hint has to itself before `padRight`
 * cuts it.
 */
const LINE_MAX_CHARS = DEFAULT_COLUMNS - ACTION_COLUMN_WIDTH - COLUMN_GAP

/** A field's hint shares a line with its label and value, so it is shorter still. */
const FIELD_HINT_MAX_CHARS = 40

/** The shape an action id is written in: the key a frame and a test name it by. */
const ACTION_ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** What a secret field is filled with, and what no `argv` may contain. */
const SECRET_SENTINEL = 'S3NT1N3L'

/**
 * Values a `text` field is filled with, tried in order: the first one its own
 * `validate` accepts is used. A pattern the catalogue validates against is
 * the store's own, so a value accepted here is one the command would accept
 * too — which is what makes the argv these tests build a realistic one.
 */
const TEXT_CANDIDATES: readonly string[] = ['files', '90d', 'a']

/** The two values a `flag` field holds; `'true'` is the one that adds a switch. */
const FLAG_ON = 'true'

/** The exact set of actions that ask before they run, as `section/id`. */
const CONFIRMING_ACTIONS: readonly string[] = [
  'admins/rotate',
  'admins/remove',
  'servers/remove',
  'vault/remove',
  'vault/rekey',
  'agents/revoke',
  'groups/remove',
  'quarantine/approve-all',
  'quarantine/reject',
  'audit/prune',
]

/** A value for one field: a sentinel for a secret, something valid for the rest. */
function fillOf(field: FieldSpec): string {
  switch (field.kind) {
    case 'secret':
      return SECRET_SENTINEL
    case 'choice':
      return field.options?.[0] ?? ''
    case 'flag':
      return FLAG_ON
    case 'text':
      return TEXT_CANDIDATES.find((candidate) => field.validate?.(candidate) === undefined) ?? ''
  }
}

/** Every field of an action, filled. */
function filledValuesOf(action: ActionSpec): FormValues {
  return Object.fromEntries(action.fields.map((field) => [field.name, fillOf(field)]))
}

/** `section/id`, the key these tests name an action by. */
function keysOf(predicate: (action: ActionSpec) => boolean): readonly string[] {
  return SECTIONS.flatMap((section) =>
    section.actions.filter(predicate).map((action) => `${section.id}/${action.id}`),
  )
}

/** Every action of every section, paired with the section it belongs to. */
function eachAction(): readonly (readonly [SectionSpec, ActionSpec])[] {
  return SECTIONS.flatMap((section) =>
    section.actions.map((action) => [section, action] as const),
  )
}

describe('every action names the command it runs', () => {
  test('argv starts with the action’s own (command, subcommand)', () => {
    for (const action of ALL_ACTIONS) {
      // Arrange
      const head =
        action.subcommand === undefined ? [action.command] : [action.command, action.subcommand]

      // Act
      const argv = action.argv(filledValuesOf(action))

      // Assert
      expect(argv.slice(0, head.length), `argv head of ${action.id}`).toEqual(head)
    }
  })

  test('argv returns a fresh array on every call: nothing shares a command line', () => {
    for (const action of ALL_ACTIONS) {
      // Arrange
      const values = filledValuesOf(action)

      // Act
      const first = action.argv(values)
      const second = action.argv(values)

      // Assert
      expect(second, `argv of ${action.id}`).not.toBe(first)
      expect(second, `argv of ${action.id}`).toEqual(first)
    }
  })

  test('the title says the command, and the id is a key a frame can hold', () => {
    for (const [section, action] of eachAction()) {
      const word = action.subcommand ?? action.command

      expect(action.title.split(' '), `title of ${section.id}/${action.id}`).toContain(word)
      expect(action.id, `id of ${section.id}/${action.id}`).toMatch(ACTION_ID_PATTERN)
    }
  })

  test('ids are unique inside their section, and section ids across the catalogue', () => {
    for (const section of SECTIONS) {
      const ids = section.actions.map((action) => action.id)
      expect(new Set(ids).size, `ids of ${section.id}`).toBe(ids.length)
    }

    const sectionIds = SECTIONS.map((section) => section.id)
    expect(new Set(sectionIds).size).toBe(sectionIds.length)
  })
})

describe('the actions that destroy something ask first', () => {
  test('exactly the destructive actions carry a confirm question', () => {
    // Act
    const asking = keysOf((action) => action.confirm !== undefined)

    // Assert
    expect(asking).toEqual(CONFIRMING_ACTIONS)
  })

  test('a confirm question is a sentence, and it names what is about to go', () => {
    for (const [section, action] of eachAction()) {
      if (action.confirm === undefined) continue

      // Act
      const question = action.confirm(filledValuesOf(action))

      // Assert: `prune` alone may decline to ask, and it is tested below
      if (question === undefined) continue
      expect(question, `confirm of ${section.id}/${action.id}`).toContain('?')
    }
  })

  test('prune asks only when it would really delete: a dry run answers nothing', () => {
    // Arrange
    const prune = ALL_ACTIONS.find((action) => action.id === 'prune')
    expect(prune).toBeDefined()
    if (prune === undefined) return

    // Act + Assert
    expect(prune.confirm?.({ 'older-than': '90d', yes: 'true' })).toContain('90d')
    expect(prune.confirm?.({ 'older-than': '90d', yes: 'false' })).toBeUndefined()
  })
})

describe('a secret never reaches a command line', () => {
  test('stdinField names a secret field of the action itself', () => {
    for (const [section, action] of eachAction()) {
      const { stdinField } = action
      if (stdinField === undefined) continue

      // Act
      const field = action.fields.find((each) => each.name === stdinField)

      // Assert
      expect(field, `stdinField of ${section.id}/${action.id}`).toBeDefined()
      expect(field?.kind, `stdinField of ${section.id}/${action.id}`).toBe('secret')
    }
  })

  // Belt and braces: `ActionSpec`'s union makes this unwritable, and this
  // asserts it of the catalogue that exists — the two fail differently, and a
  // type loosened by accident would still be caught here.
  test('an action reading stdin never also asks a question: the secret would wait in the model', () => {
    for (const [section, action] of eachAction()) {
      if (action.stdinField === undefined) continue

      expect(action.confirm, `confirm of ${section.id}/${action.id}`).toBeUndefined()
    }
  })

  test('every secret field is named by its action’s stdinField', () => {
    for (const [section, action] of eachAction()) {
      const secrets = action.fields.filter((field) => field.kind === 'secret')
      if (secrets.length === 0) continue

      expect(secrets.map((field) => field.name), `secrets of ${section.id}/${action.id}`).toEqual([
        action.stdinField,
      ])
    }
  })

  test('no argv of any action carries the value typed into a secret field', () => {
    for (const [section, action] of eachAction()) {
      // Act
      const argv = action.argv(filledValuesOf(action))

      // Assert
      expect(
        argv.some((word) => word.includes(SECRET_SENTINEL)),
        `argv of ${section.id}/${action.id}`,
      ).toBe(false)
    }
  })
})

describe('the seams a section declares point at its own fields', () => {
  test('stdoutToField names a text field of the action itself', () => {
    for (const [section, action] of eachAction()) {
      const { stdoutToField } = action
      if (stdoutToField === undefined) continue

      // Act
      const field = action.fields.find((each) => each.name === stdoutToField)

      // Assert
      expect(field, `stdoutToField of ${section.id}/${action.id}`).toBeDefined()
      expect(field?.kind, `stdoutToField of ${section.id}/${action.id}`).toBe('text')
    }
  })

  test('a section refreshes itself with an action that needs no form', () => {
    for (const section of SECTIONS) {
      const { refreshActionId } = section
      if (refreshActionId === undefined) continue

      // Act
      const action = section.actions.find((each) => each.id === refreshActionId)

      // Assert
      expect(action, `refresh of ${section.id}`).toBeDefined()
      expect(action?.fields, `refresh of ${section.id}`).toEqual([])
    }
  })
})

describe('the whole catalogue fits the 80-column screen', () => {
  test('every action title fits the action column beside its marker', () => {
    for (const [section, action] of eachAction()) {
      expect(action.title.length, `title of ${section.id}/${action.id}`).toBeLessThanOrEqual(
        TITLE_MAX_WIDTH,
      )
    }
  })

  test('every intro line fits the pane, so none of them is cut in half', () => {
    for (const section of SECTIONS) {
      for (const line of section.intro) {
        expect(line.length, `intro of ${section.id}: ${line}`).toBeLessThanOrEqual(LINE_MAX_CHARS)
      }
    }
  })

  test('every action hint fits one line of the pane', () => {
    for (const [section, action] of eachAction()) {
      expect(
        (action.hint ?? '').length,
        `hint of ${section.id}/${action.id}`,
      ).toBeLessThanOrEqual(LINE_MAX_CHARS)
    }
  })

  test('every field label fits the label column, so no value is pushed off screen', () => {
    for (const [section, action] of eachAction()) {
      for (const field of action.fields) {
        expect(
          field.label.length,
          `label of ${section.id}/${action.id}/${field.name}`,
        ).toBeLessThanOrEqual(FIELD_LABEL_MAX_WIDTH)
      }
    }
  })

  test('every field hint fits beside the value it describes', () => {
    for (const [section, action] of eachAction()) {
      for (const field of action.fields) {
        expect(
          (field.hint ?? '').length,
          `hint of ${section.id}/${action.id}/${field.name}`,
        ).toBeLessThanOrEqual(FIELD_HINT_MAX_CHARS)
      }
    }
  })
})
