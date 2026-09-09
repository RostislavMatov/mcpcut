import { describe, expect, test } from 'vitest'
import type { Role } from '../../src/admin/authz.js'
import { APPROVAL_RESOLVE_MIN_ROLE, QUARANTINE_RESOLVE_MIN_ROLE } from '../../src/admin/authz.js'
import { ACCESS_MIN_ROLE } from '../../src/cli/access-cmd-write.js'
import { POLICY_SET_MIN_ROLE } from '../../src/cli/policy-set-cmd.js'
import { PRUNE_MIN_ROLE } from '../../src/cli/prune-cmd.js'
import { SERVER_REFRESH_MIN_ROLE } from '../../src/cli/server-status-cmd.js'
import { SECTIONS } from '../../src/tui/catalogue/index.js'
import type { ActionSpec, SectionSpec } from '../../src/tui/catalogue/types.js'
import { ROUTE_TABLE, type UiMethod } from '../../src/ui/authz.js'

/**
 * The console's thresholds against the web UI's route table (phase 4 review,
 * security M3 / TS M4).
 *
 * Every section says in prose whose `minRole` it mirrors, and prose is what
 * drifts: a route lowered in `ROUTE_TABLE` leaves the console quietly stricter
 * or, far worse, quietly looser than the surface it claims to copy. This test
 * is the mirror written as an assertion — for the actions that really do have
 * a route behind them, and for the four imported constants that ARE the
 * shared answer for the rest.
 *
 * `src/tui/**` may not import `src/ui/**` (`tests/architecture/imports.test.ts`
 * — the console is an operator surface beside the admin UI, not a part of it),
 * so the comparison lives HERE: a test may read both, and only a test may.
 *
 * What deliberately has NO row below: the Audit section. `verify --sign`,
 * `keygen`, `backup`, `prune` and `migrate` are CLI commands that take no
 * admin token and are covered by no route at all, so their roles are
 * console-local ergonomics rather than a mirror of anything — see the header
 * of `src/tui/catalogue/audit.ts`.
 */

/** The minimum role of one route of the table, by method and exact pattern. */
function routeRole(method: UiMethod, pattern: string): Role | 'public' {
  const entry = ROUTE_TABLE.find((route) => route.method === method && route.pattern === pattern)
  if (entry === undefined) throw new Error(`no route ${method} ${pattern} in ROUTE_TABLE`)

  return entry.minRole
}

function sectionOf(id: string): SectionSpec {
  const section = SECTIONS.find((each) => each.id === id)
  if (section === undefined) throw new Error(`no section "${id}" in the catalogue`)

  return section
}

function actionOf(sectionId: string, actionId: string): ActionSpec {
  const action = sectionOf(sectionId).actions.find((each) => each.id === actionId)
  if (action === undefined) throw new Error(`no action "${sectionId}/${actionId}"`)

  return action
}

/** One claim of a section's prose: this action stands for that route. */
interface MirroredRoute {
  readonly sectionId: string
  readonly actionId: string
  readonly method: UiMethod
  readonly pattern: string
}

const MIRRORED_ROUTES: readonly MirroredRoute[] = [
  // Servers: registering and removing a server both move what an agent can
  // reach, and both are `owner` on the web UI.
  { sectionId: 'servers', actionId: 'add', method: 'POST', pattern: '/servers/add' },
  { sectionId: 'servers', actionId: 'remove', method: 'POST', pattern: '/servers/remove' },
  { sectionId: 'servers', actionId: 'refresh', method: 'POST', pattern: '/servers/refresh' },
  // Reading the registry names nobody and changes nothing.
  { sectionId: 'servers', actionId: 'list', method: 'GET', pattern: '/servers' },
  { sectionId: 'servers', actionId: 'show', method: 'GET', pattern: '/servers' },
  // Quarantine: reading a diff decides nothing; letting a tool out is an act.
  { sectionId: 'quarantine', actionId: 'list', method: 'GET', pattern: '/quarantine' },
  { sectionId: 'quarantine', actionId: 'show', method: 'GET', pattern: '/quarantine' },
  { sectionId: 'quarantine', actionId: 'approve', method: 'POST', pattern: '/quarantine/approve' },
  {
    sectionId: 'quarantine',
    actionId: 'approve-all',
    method: 'POST',
    pattern: '/quarantine/approve',
  },
  { sectionId: 'quarantine', actionId: 'reject', method: 'POST', pattern: '/quarantine/reject' },
  // Approvals: the queue is a viewer's to read, an operator's to resolve.
  { sectionId: 'approvals', actionId: 'list', method: 'GET', pattern: '/' },
  { sectionId: 'approvals', actionId: 'approve', method: 'POST', pattern: '/approvals/:id/approve' },
  { sectionId: 'approvals', actionId: 'deny', method: 'POST', pattern: '/approvals/:id/deny' },
  // Policy: the effective policy is read off the servers page; a rule is
  // written by the one route ADR-0009 created for it.
  { sectionId: 'policy', actionId: 'show', method: 'GET', pattern: '/servers' },
  { sectionId: 'policy', actionId: 'show-server', method: 'GET', pattern: '/servers' },
  { sectionId: 'policy', actionId: 'validate', method: 'GET', pattern: '/servers' },
  {
    sectionId: 'policy',
    actionId: 'set',
    method: 'POST',
    pattern: '/servers/:name/tools/:tool/rule',
  },
  // Agents and groups: reading the matrix is free, every edit is owner-owned
  // (decision T4, 2026-09-01).
  { sectionId: 'agents', actionId: 'list', method: 'GET', pattern: '/agents' },
  { sectionId: 'agents', actionId: 'create', method: 'POST', pattern: '/agents/create' },
  { sectionId: 'agents', actionId: 'grant', method: 'POST', pattern: '/agents/grant' },
  { sectionId: 'agents', actionId: 'ungrant', method: 'POST', pattern: '/agents/ungrant' },
  { sectionId: 'agents', actionId: 'revoke', method: 'POST', pattern: '/agents/revoke' },
  { sectionId: 'groups', actionId: 'list', method: 'GET', pattern: '/groups' },
  { sectionId: 'groups', actionId: 'show', method: 'GET', pattern: '/groups' },
  { sectionId: 'groups', actionId: 'create', method: 'POST', pattern: '/groups/create' },
  { sectionId: 'groups', actionId: 'remove', method: 'POST', pattern: '/groups/remove' },
  { sectionId: 'groups', actionId: 'grant', method: 'POST', pattern: '/groups/grant' },
  { sectionId: 'groups', actionId: 'ungrant', method: 'POST', pattern: '/groups/ungrant' },
  { sectionId: 'groups', actionId: 'join', method: 'POST', pattern: '/groups/join' },
  { sectionId: 'groups', actionId: 'leave', method: 'POST', pattern: '/groups/leave' },
  // Admins: the whole section is the owner-only admin page.
  { sectionId: 'admins', actionId: 'list', method: 'GET', pattern: '/admins' },
  { sectionId: 'admins', actionId: 'add', method: 'POST', pattern: '/admins/add' },
  { sectionId: 'admins', actionId: 'remove', method: 'POST', pattern: '/admins/remove' },
  { sectionId: 'admins', actionId: 'rotate', method: 'POST', pattern: '/admins/rotate' },
  { sectionId: 'admins', actionId: 'role', method: 'POST', pattern: '/admins/role' },
]

describe('an action that mirrors a route carries that route’s threshold', () => {
  test.each(MIRRORED_ROUTES)(
    '$sectionId/$actionId = $method $pattern',
    ({ sectionId, actionId, method, pattern }) => {
      expect(actionOf(sectionId, actionId).minRole).toBe(routeRole(method, pattern))
    },
  )
})

describe('a section that mirrors a page carries that page’s threshold', () => {
  test('the Vault section is the owner-only vault page', () => {
    // The names of the secrets are all either surface shows; both are `owner`.
    expect(sectionOf('vault').minRole).toBe(routeRole('GET', '/vault'))
    for (const action of sectionOf('vault').actions) {
      expect(action.minRole, `vault/${action.id}`).toBe(routeRole('GET', '/vault'))
    }
  })

  test('the Admins section is the owner-only admins page', () => {
    expect(sectionOf('admins').minRole).toBe(routeRole('GET', '/admins'))
  })
})

/**
 * The four constants a section imports rather than restating. They are the
 * shared answer by construction — the point of these rows is that the
 * catalogue still USES them, so a role typed in by hand later cannot pass
 * unnoticed just because it happens to read `'owner'` today.
 */
describe('an action that imports its threshold still holds the imported value', () => {
  test('server refresh is SERVER_REFRESH_MIN_ROLE, the constant the route uses too', () => {
    expect(actionOf('servers', 'refresh').minRole).toBe(SERVER_REFRESH_MIN_ROLE)
    expect(routeRole('POST', '/servers/refresh')).toBe(SERVER_REFRESH_MIN_ROLE)
  })

  test('policy set is POLICY_SET_MIN_ROLE, the constant the rule route uses too', () => {
    expect(actionOf('policy', 'set').minRole).toBe(POLICY_SET_MIN_ROLE)
    expect(routeRole('POST', '/servers/:name/tools/:tool/rule')).toBe(POLICY_SET_MIN_ROLE)
  })

  test('resolving an approval is APPROVAL_RESOLVE_MIN_ROLE on both surfaces', () => {
    for (const actionId of ['approve', 'deny']) {
      expect(actionOf('approvals', actionId).minRole).toBe(APPROVAL_RESOLVE_MIN_ROLE)
    }
    expect(routeRole('POST', '/approvals/:id/approve')).toBe(APPROVAL_RESOLVE_MIN_ROLE)
    expect(routeRole('POST', '/approvals/:id/deny')).toBe(APPROVAL_RESOLVE_MIN_ROLE)
  })

  test('resolving a quarantined tool is QUARANTINE_RESOLVE_MIN_ROLE on both surfaces (Q17)', () => {
    for (const actionId of ['approve', 'approve-all', 'reject']) {
      expect(actionOf('quarantine', actionId).minRole).toBe(QUARANTINE_RESOLVE_MIN_ROLE)
    }
    expect(routeRole('POST', '/quarantine/approve')).toBe(QUARANTINE_RESOLVE_MIN_ROLE)
    expect(routeRole('POST', '/quarantine/reject')).toBe(QUARANTINE_RESOLVE_MIN_ROLE)
  })

  test('prune is PRUNE_MIN_ROLE, the threshold the command itself enforces (Q17)', () => {
    expect(actionOf('audit', 'prune').minRole).toBe(PRUNE_MIN_ROLE)
    expect(PRUNE_MIN_ROLE).toBe('owner')
  })

  test('every agent and group mutation is ACCESS_MIN_ROLE', () => {
    const mutations: readonly [string, readonly string[]][] = [
      ['agents', ['create', 'grant', 'ungrant', 'revoke']],
      ['groups', ['create', 'remove', 'grant', 'ungrant', 'join', 'leave']],
    ]

    for (const [sectionId, actionIds] of mutations) {
      for (const actionId of actionIds) {
        expect(actionOf(sectionId, actionId).minRole, `${sectionId}/${actionId}`).toBe(
          ACCESS_MIN_ROLE,
        )
      }
    }
  })
})

describe('the mirror is not vacuous', () => {
  test('every row names an action and a route that really exist', () => {
    for (const row of MIRRORED_ROUTES) {
      expect(actionOf(row.sectionId, row.actionId).id).toBe(row.actionId)
      expect(routeRole(row.method, row.pattern)).not.toBe('public')
    }
  })

  test('a route the table does not hold is an error, not a silent pass', () => {
    expect(() => routeRole('POST', '/policy/set')).toThrow(/no route/)
  })
})
