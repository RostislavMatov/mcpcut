import { describe, expect, test } from 'vitest'
import type { Role } from '../../src/admin/authz.js'
import { AGENT_NAME_PATTERN } from '../../src/agents/constants.js'
import { GROUP_NAME_PATTERN } from '../../src/groups/constants.js'
import { AGENTS_SECTION } from '../../src/tui/catalogue/agents.js'
import { GROUPS_SECTION } from '../../src/tui/catalogue/groups.js'
import { visibleActions } from '../../src/tui/catalogue/index.js'
import type { ActionSpec, SectionSpec } from '../../src/tui/catalogue/types.js'
import { ACTION_COLUMN_WIDTH, ACTIVE_MARKER } from '../../src/tui/constants.js'
import type { FormValues } from '../../src/tui/form.js'

/**
 * The Agents and Groups sections (mcpcut phase 4, Task 5): the two screens
 * that decide who reaches which server.
 *
 * Three things are load-bearing and asserted below. Every `argv` must be a
 * command line the CLI's own parser accepts — an optional flag left empty has
 * to VANISH rather than travel as an empty string. The `--tools` asymmetry is
 * the security contract of `src/cli/grant-flags.ts`, so the form states it
 * the same way in both directions: `agent grant` without tools grants all of
 * them, `group grant` refuses to run without them. And the role thresholds
 * mirror `ACCESS_MIN_ROLE` (owner), so an operator is never shown a mutation
 * that the command behind it would refuse.
 */

/** Longest title the action column can print beside its marker. */
const TITLE_MAX_WIDTH = ACTION_COLUMN_WIDTH - ACTIVE_MARKER.length

/** A field's hint shares a line with its value, so it is the shortest text here. */
const FIELD_HINT_MAX_CHARS = 40

/** An action hint and an intro line each own a whole line of the output pane. */
const LINE_MAX_CHARS = 54

/** Every field of both sections filled with something the CLI would accept. */
const FILLED: FormValues = {
  name: 'reader',
  agent: 'reader',
  group: 'analytics',
  server: 'files',
  tools: 'read_*,list_*',
  resources: 'file:///project/*',
  prompts: 'greet*',
}

function actionOf(section: SectionSpec, id: string): ActionSpec {
  const action = section.actions.find((candidate) => candidate.id === id)
  if (action === undefined) throw new Error(`no action "${id}" in section "${section.id}"`)
  return action
}

function fieldNamesOf(action: ActionSpec): readonly string[] {
  return action.fields.map((field) => field.name)
}

function actionIdsFor(section: SectionSpec, role: Role): readonly string[] {
  return visibleActions(section, role).map((action) => action.id)
}

describe('the Agents section runs the agent commands', () => {
  test.each([
    ['list', ['agent', 'list']],
    ['create', ['agent', 'create', 'reader']],
    [
      'grant',
      [
        'agent',
        'grant',
        'reader',
        'files',
        '--tools',
        'read_*,list_*',
        '--resources',
        'file:///project/*',
        '--prompts',
        'greet*',
      ],
    ],
    ['ungrant', ['agent', 'ungrant', 'reader', 'files']],
    ['revoke', ['agent', 'revoke', 'reader']],
  ])('%s builds the command line the CLI parses', (id, expected) => {
    // Arrange
    const action = actionOf(AGENTS_SECTION, id)

    // Act
    const argv = action.argv(FILLED)

    // Assert
    expect(argv).toEqual(expected)
  })

  test('an empty optional grant flag is left out of the command line entirely', () => {
    // Arrange
    const grant = actionOf(AGENTS_SECTION, 'grant')
    const values: FormValues = { agent: 'reader', server: 'files', tools: '', resources: '', prompts: '' }

    // Act
    const argv = grant.argv(values)

    // Assert
    expect(argv).toEqual(['agent', 'grant', 'reader', 'files'])
  })

  test('the section reads its own state on refresh and starts at viewer', () => {
    // Arrange & Act & Assert
    expect(AGENTS_SECTION.id).toBe('agents')
    expect(AGENTS_SECTION.minRole).toBe('viewer')
    expect(AGENTS_SECTION.refreshActionId).toBe('list')
  })
})

describe('the Groups section runs the group commands', () => {
  test.each([
    ['list', ['group', 'list']],
    ['show', ['group', 'show', 'analytics']],
    ['create', ['group', 'create', 'analytics']],
    ['remove', ['group', 'remove', 'analytics']],
    [
      'grant',
      [
        'group',
        'grant',
        'analytics',
        'files',
        '--tools',
        'read_*,list_*',
        '--resources',
        'file:///project/*',
        '--prompts',
        'greet*',
      ],
    ],
    ['ungrant', ['group', 'ungrant', 'analytics', 'files']],
    ['join', ['group', 'join', 'analytics', 'reader']],
    ['leave', ['group', 'leave', 'analytics', 'reader']],
  ])('%s builds the command line the CLI parses', (id, expected) => {
    // Arrange
    const action = actionOf(GROUPS_SECTION, id)

    // Act
    const argv = action.argv(FILLED)

    // Assert
    expect(argv).toEqual(expected)
  })

  test('an empty optional method flag is left out while --tools stays', () => {
    // Arrange
    const grant = actionOf(GROUPS_SECTION, 'grant')
    const values: FormValues = { group: 'analytics', server: 'files', tools: '*', resources: '', prompts: '' }

    // Act
    const argv = grant.argv(values)

    // Assert
    expect(argv).toEqual(['group', 'grant', 'analytics', 'files', '--tools', '*'])
  })

  test('the section reads its own state on refresh and starts at viewer', () => {
    // Arrange & Act & Assert
    expect(GROUPS_SECTION.id).toBe('groups')
    expect(GROUPS_SECTION.minRole).toBe('viewer')
    expect(GROUPS_SECTION.refreshActionId).toBe('list')
  })
})

describe('the --tools asymmetry of grant-flags.ts reaches both forms', () => {
  test('group grant makes tools required: the CLI refuses the command without it', () => {
    // Arrange
    const grant = actionOf(GROUPS_SECTION, 'grant')

    // Act
    const tools = grant.fields.find((field) => field.name === 'tools')

    // Assert
    expect(tools?.required).toBe(true)
  })

  test('agent grant leaves tools optional, and says an empty one means ALL tools', () => {
    // Arrange
    const grant = actionOf(AGENTS_SECTION, 'grant')

    // Act
    const tools = grant.fields.find((field) => field.name === 'tools')

    // Assert
    expect(tools?.required).toBeFalsy()
    expect(tools?.hint).toContain('ALL tools')
  })

  test.each([
    ['agents', AGENTS_SECTION],
    ['groups', GROUPS_SECTION],
  ])('%s says an omitted resources/prompts flag leaves the surface denied', (_id, section) => {
    // Arrange
    const grant = actionOf(section, 'grant')

    // Act
    const hints = grant.fields
      .filter((field) => field.name === 'resources' || field.name === 'prompts')
      .map((field) => field.hint ?? '')

    // Assert
    expect(hints).toHaveLength(2)
    for (const hint of hints) expect(hint).toContain('denied')
  })
})

describe('role thresholds mirror ACCESS_MIN_ROLE: every mutation is owner-only', () => {
  test.each([
    ['viewer' as Role, ['list']],
    ['operator' as Role, ['list']],
    ['owner' as Role, ['list', 'create', 'grant', 'ungrant', 'revoke']],
  ])('a %s sees exactly the agents actions it may run', (role, expected) => {
    // Arrange & Act
    const ids = actionIdsFor(AGENTS_SECTION, role)

    // Assert
    expect(ids).toEqual(expected)
  })

  test.each([
    ['viewer' as Role, ['list', 'show']],
    ['operator' as Role, ['list', 'show']],
    ['owner' as Role, ['list', 'show', 'create', 'remove', 'grant', 'ungrant', 'join', 'leave']],
  ])('a %s sees exactly the groups actions it may run', (role, expected) => {
    // Arrange & Act
    const ids = actionIdsFor(GROUPS_SECTION, role)

    // Assert
    expect(ids).toEqual(expected)
  })
})

describe('only the two destructive actions ask first', () => {
  test('agent revoke names the agent that is about to lose its token', () => {
    // Arrange
    const revoke = actionOf(AGENTS_SECTION, 'revoke')

    // Act
    const question = revoke.confirm?.(FILLED)

    // Assert
    expect(question).toBe('Revoke agent "reader"? Its token stops working at once.')
  })

  test('group remove names the group and why the command may still refuse', () => {
    // Arrange
    const remove = actionOf(GROUPS_SECTION, 'remove')

    // Act
    const question = remove.confirm?.(FILLED)

    // Assert
    expect(question).toBe('Remove group "analytics"? (refused while it still has members)')
  })

  test.each([
    ['agents', AGENTS_SECTION, 'revoke'],
    ['groups', GROUPS_SECTION, 'remove'],
  ])('%s carries confirm on that action alone', (_id, section, confirming) => {
    // Arrange & Act
    const asking = section.actions.filter((action) => action.confirm !== undefined)

    // Assert
    expect(asking.map((action) => action.id)).toEqual([confirming])
  })
})

describe('both sections fit the screen they are drawn on', () => {
  const sections: readonly SectionSpec[] = [AGENTS_SECTION, GROUPS_SECTION]
  const actions: readonly ActionSpec[] = sections.flatMap((section) => section.actions)

  test('every action title fits the action column beside its marker', () => {
    for (const action of actions) {
      expect(action.title.length, `title of ${action.id}`).toBeLessThanOrEqual(TITLE_MAX_WIDTH)
    }
  })

  test('every intro and action hint fits one line of the pane', () => {
    for (const section of sections) {
      for (const line of section.intro) {
        expect(line.length, `intro of ${section.id}`).toBeLessThanOrEqual(LINE_MAX_CHARS)
      }
    }
    for (const action of actions) {
      expect((action.hint ?? '').length, `hint of ${action.id}`).toBeLessThanOrEqual(LINE_MAX_CHARS)
    }
  })

  test('every field hint fits beside the value it describes', () => {
    for (const action of actions) {
      for (const field of action.fields) {
        expect((field.hint ?? '').length, `hint of ${field.name}`).toBeLessThanOrEqual(
          FIELD_HINT_MAX_CHARS,
        )
      }
    }
  })
})

describe('names are validated by the pattern the store enforces', () => {
  test.each([
    ['agents create name', AGENTS_SECTION, 'create', 'name', AGENT_NAME_PATTERN],
    ['groups show group', GROUPS_SECTION, 'show', 'group', GROUP_NAME_PATTERN],
    ['groups join agent', GROUPS_SECTION, 'join', 'agent', AGENT_NAME_PATTERN],
  ])('%s rejects a name with a space, quoting the pattern', (_case, section, id, fieldName, pattern) => {
    // Arrange
    const field = actionOf(section, id).fields.find((candidate) => candidate.name === fieldName)

    // Act
    const error = field?.validate?.('Bad Name')

    // Assert
    expect(error).toBe(`must match ${pattern.source}`)
  })

  test('argv returns a fresh array on every call: nothing shares a command line', () => {
    // Arrange
    const actions = [...AGENTS_SECTION.actions, ...GROUPS_SECTION.actions]

    // Act & Assert
    for (const action of actions) {
      const first = action.argv(FILLED)
      const second = action.argv(FILLED)
      expect(first, `argv of ${action.id}`).not.toBe(second)
      expect(first).toEqual(second)
    }
  })

  test('the grant forms collect exactly the positionals and flags their command takes', () => {
    // Arrange & Act & Assert
    expect(fieldNamesOf(actionOf(AGENTS_SECTION, 'grant'))).toEqual([
      'agent',
      'server',
      'tools',
      'resources',
      'prompts',
    ])
    expect(fieldNamesOf(actionOf(GROUPS_SECTION, 'grant'))).toEqual([
      'group',
      'server',
      'tools',
      'resources',
      'prompts',
    ])
  })
})
