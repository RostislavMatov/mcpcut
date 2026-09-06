import { describe, expect, test } from 'vitest'
import type { Role } from '../../src/admin/authz.js'
import { ADMIN_ROLES } from '../../src/admin/constants.js'
import {
  actionAt,
  cataloguePairs,
  SECTIONS,
  visibleActions,
  visibleSections,
} from '../../src/tui/catalogue/index.js'
import type { ActionSpec } from '../../src/tui/catalogue/types.js'
import { formOf, valuesOf, type FormValues } from '../../src/tui/form.js'

/**
 * The console's catalogue (phase 2, Task 6): the declarative sections the
 * console draws and the argv every action builds.
 *
 * Two things are load-bearing here and both are asserted below. The role
 * thresholds mirror `ROUTE_TABLE` (`GET /admins` → owner), so a section that
 * a role may not use never reaches a frame; and every `argv` builder is a
 * pure function returning a FRESH array, because the runtime hands that array
 * to `dispatch` and a shared array would let one run rewrite the next one's
 * command line.
 */

/** Every action of every section, regardless of role. */
const ALL_ACTIONS: readonly ActionSpec[] = SECTIONS.flatMap((section) => section.actions)

/** The values a freshly opened form of the action would carry. */
function defaultValuesOf(action: ActionSpec): FormValues {
  return valuesOf(formOf(action.fields))
}

/** `command` and `subcommand` as one comparable string. */
function pairKeyOf(pair: { readonly command: string; readonly subcommand?: string }): string {
  return pair.subcommand === undefined ? pair.command : `${pair.command} ${pair.subcommand}`
}

function sectionIdsFor(role: Role): readonly string[] {
  return visibleSections(role).map((section) => section.id)
}

describe('role thresholds mirror the UI route table', () => {
  test('a viewer sees Home only', () => {
    expect(sectionIdsFor('viewer')).toEqual(['home'])
  })

  test('an operator sees Home only: admin edits are owner work (GET /admins → owner)', () => {
    expect(sectionIdsFor('operator')).toEqual(['home'])
  })

  test('an owner sees Home and Admins, in that order', () => {
    expect(sectionIdsFor('owner')).toEqual(['home', 'admins'])
  })

  test('a section with no action the role may run is not shown at all', () => {
    const ownerOnlySection = {
      id: 'nothing-visible',
      title: 'Nothing',
      minRole: 'viewer' as const,
      intro: [],
      actions: [
        {
          id: 'edit',
          title: 'edit',
          minRole: 'owner' as const,
          command: 'admin',
          subcommand: 'list',
          fields: [],
          argv: () => ['admin', 'list'],
        },
      ],
    }

    expect(visibleSections('viewer', [ownerOnlySection])).toEqual([])
    expect(visibleSections('owner', [ownerOnlySection])).toEqual([ownerOnlySection])
  })

  test('visibleActions hides what the role may not run', () => {
    const admins = visibleSections('owner').find((section) => section.id === 'admins')
    expect(admins).toBeDefined()
    if (admins === undefined) return

    expect(visibleActions(admins, 'owner').map((action) => action.id)).toEqual([
      'list',
      'add',
      'rotate',
      'role',
      'remove',
    ])
    expect(visibleActions(admins, 'operator')).toEqual([])
  })
})

describe('every action names the command it runs', () => {
  test('argv starts with the action’s own (command, subcommand)', () => {
    for (const action of ALL_ACTIONS) {
      const argv = action.argv(defaultValuesOf(action))
      const head = action.subcommand === undefined ? [action.command] : [action.command, action.subcommand]

      expect(argv.slice(0, head.length), `argv head of ${action.id}`).toEqual(head)
    }
  })

  test('the id is the subcommand it runs (or the command, when there is none)', () => {
    for (const action of ALL_ACTIONS) {
      expect(action.id).toBe(action.subcommand ?? action.command)
      expect(action.title).toBe(action.id)
    }
  })

  test('argv returns a fresh array on every call: nothing shares a command line', () => {
    for (const action of ALL_ACTIONS) {
      const values = defaultValuesOf(action)
      const first = action.argv(values)
      const second = action.argv(values)

      expect(second).not.toBe(first)
      expect(second).toEqual(first)
    }
  })

  test('admin add builds the flags of `admin add <name> --role <role>`', () => {
    const add = ALL_ACTIONS.find((action) => action.id === 'add')
    expect(add).toBeDefined()
    if (add === undefined) return

    expect(add.argv({ name: 'bob', role: 'owner' })).toEqual([
      'admin',
      'add',
      'bob',
      '--role',
      'owner',
    ])
  })
})

describe('the actions that destroy something ask first', () => {
  test('rotate and remove carry a confirm question, and only they do', () => {
    const withConfirm = ALL_ACTIONS.filter((action) => action.confirm !== undefined).map(
      (action) => action.id,
    )

    expect(withConfirm).toEqual(['rotate', 'remove'])
  })

  test('the question names the admin the operator typed', () => {
    for (const action of ALL_ACTIONS.filter((each) => each.confirm !== undefined)) {
      expect(action.confirm?.({ name: 'bob' })).toContain('bob')
    }
  })
})

describe('the fields of the Admins section', () => {
  const admins = SECTIONS.find((section) => section.id === 'admins')

  test('the name validator accepts a DNS-label name and refuses anything else', () => {
    const add = admins?.actions.find((action) => action.id === 'add')
    const name = add?.fields.find((field) => field.name === 'name')
    expect(name?.validate).toBeDefined()

    expect(name?.validate?.('bob')).toBeUndefined()
    expect(name?.validate?.('Bad Name')).toContain('must match')
  })

  test('the role field is a choice over exactly the three fixed roles', () => {
    const add = admins?.actions.find((action) => action.id === 'add')
    const role = add?.fields.find((field) => field.name === 'role')

    expect(role?.kind).toBe('choice')
    expect(role?.options).toEqual([...ADMIN_ROLES])
  })

  test('the section refreshes itself by running its own list action', () => {
    expect(admins?.refreshActionId).toBe('list')
    expect(admins?.actions.some((action) => action.id === admins.refreshActionId)).toBe(true)
  })
})

describe('the Home section', () => {
  const home = SECTIONS.find((section) => section.id === 'home')

  test('its intro tells the operator how to run an agent, outside the console', () => {
    expect(home?.intro[0]).toBe('Run an agent through the plane (outside this console):')
    expect(home?.intro.join('\n')).toContain('connect <server> --agent <name>')
    expect(home?.intro.join('\n')).toContain('wrap --server <name>')
  })

  test('its only action is `status`, which is also its refresh', () => {
    expect(home?.actions.map((action) => action.id)).toEqual(['status'])
    expect(home?.actions[0]?.argv({})).toEqual(['status'])
    expect(home?.refreshActionId).toBe('status')
  })
})

describe('cataloguePairs', () => {
  test('lists every (command, subcommand) the catalogue can run, without duplicates', () => {
    const keys = cataloguePairs().map(pairKeyOf)

    expect(keys).toEqual([
      'status',
      'admin list',
      'admin add',
      'admin rotate',
      'admin role',
      'admin remove',
    ])
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('deduplicates two actions that run the same command', () => {
    const twice = {
      id: 'twice',
      title: 'Twice',
      minRole: 'viewer' as const,
      intro: [],
      actions: [
        { id: 'a', title: 'a', minRole: 'viewer' as const, command: 'status', fields: [], argv: () => ['status'] },
        { id: 'b', title: 'b', minRole: 'viewer' as const, command: 'status', fields: [], argv: () => ['status'] },
      ],
    }

    expect(cataloguePairs([twice])).toEqual([{ command: 'status' }])
  })
})

describe('actionAt', () => {
  const sections = visibleSections('owner')

  test('finds the action a pair of cursor positions points at', () => {
    expect(actionAt(sections, 'owner', 1, 1)?.id).toBe('add')
    expect(actionAt(sections, 'owner', 0, 0)?.id).toBe('status')
  })

  test('an index outside the catalogue is undefined, not a crash', () => {
    expect(actionAt(sections, 'owner', 9, 0)).toBeUndefined()
    expect(actionAt(sections, 'owner', 1, 9)).toBeUndefined()
    expect(actionAt(sections, 'owner', -1, 0)).toBeUndefined()
    expect(actionAt(sections, 'owner', 0, -1)).toBeUndefined()
  })

  test('a role that may not run the action gets nothing, whatever list it indexes', () => {
    expect(actionAt(SECTIONS, 'viewer', 1, 0)).toBeUndefined()
    expect(actionAt(SECTIONS, 'operator', 1, 0)).toBeUndefined()
  })
})
