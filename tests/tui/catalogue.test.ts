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

/**
 * The catalogue as the console reads it: the four pure lookups every screen is
 * drawn from (phase 2, Task 6) and the twelve sections they now answer over
 * (phase 4, Task 10; Services in phase 5, Task 3).
 *
 * What is load-bearing here is the SHAPE of the catalogue: which sections a
 * role may open, in which order, and the full list of commands the console can
 * run — the list `tests/tui/catalogue-parity.test.ts` subtracts from `USAGE`,
 * so that a command still out of reach is a listed omission rather than one
 * nobody noticed. The rules that must hold over every action of every section
 * (fresh argv, no secret in a command line, widths) live one file over, in
 * `catalogue-invariants.test.ts`; the meaning of each section lives in
 * `catalogue-servers`, `catalogue-access` and `catalogue-journal`, and the
 * shared field constructors in `catalogue-fields.test.ts`.
 */

/** One action of the Admins section, the section this file speaks for. */
function adminsActionOf(id: string): ActionSpec | undefined {
  return SECTIONS.find((section) => section.id === 'admins')?.actions.find(
    (action) => action.id === id,
  )
}

/** `command` and `subcommand` as one comparable string. */
function pairKeyOf(pair: { readonly command: string; readonly subcommand?: string }): string {
  return pair.subcommand === undefined ? pair.command : `${pair.command} ${pair.subcommand}`
}

function sectionIdsFor(role: Role): readonly string[] {
  return visibleSections(role).map((section) => section.id)
}

/** The ten sections a role below owner may open, in catalogue order. */
const READABLE_SECTIONS: readonly string[] = [
  'home',
  'servers',
  'agents',
  'groups',
  'policy',
  'quarantine',
  'approvals',
  'journal',
  'audit',
  'services',
]

/** All twelve, in the order the tab bar shows them. */
const ALL_SECTIONS: readonly string[] = [
  'home',
  'admins',
  'servers',
  'vault',
  'agents',
  'groups',
  'policy',
  'quarantine',
  'approvals',
  'journal',
  'audit',
  'services',
]

describe('role thresholds mirror the UI route table', () => {
  test('a viewer sees every section except the two that only edit identities', () => {
    expect(sectionIdsFor('viewer')).toEqual(READABLE_SECTIONS)
  })

  test('an operator sees the same ten: Admins and Vault are owner work', () => {
    expect(sectionIdsFor('operator')).toEqual(READABLE_SECTIONS)
  })

  test('an owner sees all twelve, in the order the tab bar draws them', () => {
    expect(sectionIdsFor('owner')).toEqual(ALL_SECTIONS)
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

describe('the argv of the Admins section', () => {
  test('admin add builds the flags of `admin add <name> --role <role>`', () => {
    const add = adminsActionOf('add')

    expect(add?.argv({ name: 'bob', role: 'owner' })).toEqual([
      'admin',
      'add',
      'bob',
      '--role',
      'owner',
    ])
  })

  test('the question of a destructive action names the admin the operator typed', () => {
    for (const id of ['rotate', 'remove']) {
      expect(adminsActionOf(id)?.confirm?.({ name: 'bob' }), id).toContain('bob')
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
    expect(home?.intro.join('\n')).toContain('MCP_AGENT_TOKEN')
  })

  test('its only action is `status`, which is also its refresh', () => {
    expect(home?.actions.map((action) => action.id)).toEqual(['status'])
    expect(home?.actions[0]?.argv({})).toEqual(['status'])
    expect(home?.refreshActionId).toBe('status')
  })
})

/**
 * Every command the console can run, in catalogue order — the six of phase 2,
 * the forty-one of phase 4 and the four of phase 5. Written out rather than
 * derived, because this is the list the parity test subtracts from `USAGE`: a
 * command that silently left the console must fail HERE, where it can be read,
 * rather than turn the parity test's own omission list green by shrinking both
 * sides at once.
 */
const CATALOGUE_PAIR_KEYS: readonly string[] = [
  'status',
  'admin list',
  'admin add',
  'admin rotate',
  'admin role',
  'admin remove',
  'server list',
  'server show',
  'server add',
  'server refresh',
  'server remove',
  'vault list',
  'vault init',
  'vault set',
  'vault remove',
  'vault rekey',
  'agent list',
  'agent create',
  'agent grant',
  'agent ungrant',
  'agent revoke',
  'group list',
  'group show',
  'group create',
  'group remove',
  'group grant',
  'group ungrant',
  'group join',
  'group leave',
  'policy show',
  'policy validate',
  'policy set',
  'quarantine list',
  'quarantine show',
  'quarantine approve',
  'quarantine reject',
  'approvals list',
  'approvals approve',
  'approvals deny',
  'sessions',
  'show',
  'export',
  'verify',
  'keygen',
  'backup',
  'prune',
  'migrate',
  'start',
  'stop',
  'logs',
  'setup',
]

describe('cataloguePairs', () => {
  test('lists every (command, subcommand) the catalogue can run, in catalogue order', () => {
    const keys = cataloguePairs().map(pairKeyOf)

    expect(keys).toEqual(CATALOGUE_PAIR_KEYS)
  })

  test('no command is listed twice, however many actions wear it', () => {
    const keys = cataloguePairs().map(pairKeyOf)

    expect(new Set(keys).size).toBe(keys.length)
  })

  test('the three forms of verify are one command, and the two exports another', () => {
    const keys = cataloguePairs().map(pairKeyOf)
    const ids = SECTIONS.flatMap((section) => section.actions.map((action) => action.id))

    expect(ids).toEqual(expect.arrayContaining(['verify', 'verify-sign', 'verify-report']))
    expect(keys.filter((key) => key === 'verify')).toHaveLength(1)
    expect(ids).toEqual(expect.arrayContaining(['export', 'export-report']))
    expect(keys.filter((key) => key === 'export')).toHaveLength(1)
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

  test('the last section is reachable: the cursor is not bounded by the phase-2 two', () => {
    const last = ALL_SECTIONS.length - 1

    expect(sections[last]?.id).toBe('services')
    expect(actionAt(sections, 'owner', last, 0)?.id).toBe('status')
  })

  test('an index outside the catalogue is undefined, not a crash', () => {
    expect(actionAt(sections, 'owner', ALL_SECTIONS.length, 0)).toBeUndefined()
    expect(actionAt(sections, 'owner', 1, 9)).toBeUndefined()
    expect(actionAt(sections, 'owner', -1, 0)).toBeUndefined()
    expect(actionAt(sections, 'owner', 0, -1)).toBeUndefined()
  })

  test('a role that may not run the action gets nothing, whatever list it indexes', () => {
    expect(actionAt(SECTIONS, 'viewer', 1, 0)).toBeUndefined()
    expect(actionAt(SECTIONS, 'operator', 1, 0)).toBeUndefined()
  })
})
