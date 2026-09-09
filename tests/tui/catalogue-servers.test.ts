import { describe, expect, test } from 'vitest'
import type { Role } from '../../src/admin/authz.js'
import { visibleActions } from '../../src/tui/catalogue/index.js'
import { POLICY_SECTION } from '../../src/tui/catalogue/policy.js'
import { QUARANTINE_SECTION } from '../../src/tui/catalogue/quarantine.js'
import { SERVERS_SECTION } from '../../src/tui/catalogue/servers.js'
import type { ActionSpec, SectionSpec } from '../../src/tui/catalogue/types.js'
import { VAULT_SECTION } from '../../src/tui/catalogue/vault.js'
import { ACTION_COLUMN_WIDTH, ACTIVE_MARKER } from '../../src/tui/constants.js'
import { formOf, valuesOf, type FormValues } from '../../src/tui/form.js'

/**
 * The four sections of the plane's own surface (mcpcut phase 4, Task 4):
 * Servers, Vault, Policy, Quarantine.
 *
 * What is asserted here is that each action builds a command line the CLI
 * would accept, that an unfilled optional field leaves its flag out entirely
 * (rather than passing an empty string the parser would take as a value),
 * that the role thresholds keep a screen free of dead ends, and — the one
 * that would be a security bug rather than a UX one — that the value typed
 * into `vault set` never appears in an argv.
 */

/** A value no real name would carry, so finding it in an argv is unambiguous. */
const SECRET_SENTINEL = 'S3NT1N3L'

const SECTIONS_UNDER_TEST: readonly SectionSpec[] = [
  SERVERS_SECTION,
  VAULT_SECTION,
  POLICY_SECTION,
  QUARANTINE_SECTION,
]

function actionOf(section: SectionSpec, id: string): ActionSpec {
  const action = section.actions.find((candidate) => candidate.id === id)
  if (action === undefined) throw new Error(`no action "${id}" in section "${section.id}"`)
  return action
}

/** The values a freshly opened form of the action would carry. */
function defaultValuesOf(action: ActionSpec): FormValues {
  return valuesOf(formOf(action.fields))
}

/** Every field filled: secrets with the sentinel, everything else with its own name. */
function sentinelValuesOf(action: ActionSpec): FormValues {
  return Object.fromEntries(
    action.fields.map((field) => [
      field.name,
      field.kind === 'secret' ? SECRET_SENTINEL : (field.options?.[0] ?? field.name),
    ]),
  )
}

function actionIdsFor(section: SectionSpec, role: Role): readonly string[] {
  return visibleActions(section, role).map((action) => action.id)
}

describe('Servers builds the command lines `server *` accepts', () => {
  const cases: readonly {
    readonly id: string
    readonly values: FormValues
    readonly expected: readonly string[]
  }[] = [
    { id: 'list', values: {}, expected: ['server', 'list'] },
    { id: 'show', values: { name: 'files' }, expected: ['server', 'show', 'files'] },
    {
      id: 'add',
      values: {
        name: 'files',
        transport: 'http',
        command: '/usr/bin/mcp-files',
        args: '--root,/srv',
        env: 'A=1, B=vault:x',
        url: 'https://files.example/mcp',
        header: 'X-Key=vault:x, X-Two=2',
        protocol: 'stateless',
      },
      expected: [
        'server',
        'add',
        'files',
        '--transport',
        'http',
        '--command',
        '/usr/bin/mcp-files',
        '--args',
        '--root,/srv',
        '--env',
        'A=1',
        '--env',
        'B=vault:x',
        '--url',
        'https://files.example/mcp',
        '--header',
        'X-Key=vault:x',
        '--header',
        'X-Two=2',
        '--protocol',
        'stateless',
      ],
    },
    { id: 'refresh', values: { name: 'files' }, expected: ['server', 'refresh', 'files'] },
    {
      id: 'remove',
      values: { name: 'files', 'prune-grants': 'true' },
      expected: ['server', 'remove', 'files', '--prune-grants'],
    },
  ]

  test.each(cases)('$id turns the filled form into its argv', ({ id, values, expected }) => {
    // Arrange
    const action = actionOf(SERVERS_SECTION, id)

    // Act
    const argv = action.argv(values)

    // Assert
    expect(argv).toEqual(expected)
  })

  test('add with only the stdio fields filled passes exactly the stdio flags', () => {
    // Arrange
    const action = actionOf(SERVERS_SECTION, 'add')
    const values: FormValues = {
      ...defaultValuesOf(action),
      name: 'files',
      transport: 'stdio',
      command: '/usr/bin/mcp-files',
      args: '--root,/srv',
    }

    // Act
    const argv = action.argv(values)

    // Assert
    expect(argv).toEqual([
      'server',
      'add',
      'files',
      '--transport',
      'stdio',
      '--command',
      '/usr/bin/mcp-files',
      '--args',
      '--root,/srv',
    ])
  })

  test('an unfilled optional field leaves its flag out rather than passing an empty value', () => {
    // Arrange
    const action = actionOf(SERVERS_SECTION, 'add')
    const values: FormValues = { ...defaultValuesOf(action), name: 'files' }

    // Act
    const argv = action.argv(values)

    // Assert
    expect(argv).toEqual(['server', 'add', 'files', '--transport', 'stdio'])
  })

  test('an unset flag field leaves --prune-grants out of server remove', () => {
    // Arrange
    const action = actionOf(SERVERS_SECTION, 'remove')
    const values: FormValues = { ...defaultValuesOf(action), name: 'files' }

    // Act
    const argv = action.argv(values)

    // Assert
    expect(argv).toEqual(['server', 'remove', 'files'])
  })

  test('the env field repeats --env once per comma-separated pair, trimmed', () => {
    // Arrange
    const action = actionOf(SERVERS_SECTION, 'add')
    const values: FormValues = {
      ...defaultValuesOf(action),
      name: 'files',
      env: 'A=1, B=vault:x',
    }

    // Act
    const argv = action.argv(values)

    // Assert
    expect(argv.slice(-4)).toEqual(['--env', 'A=1', '--env', 'B=vault:x'])
  })

  test('remove names the server the operator typed and what removing it drops', () => {
    // Arrange
    const action = actionOf(SERVERS_SECTION, 'remove')

    // Act
    const question = action.confirm?.({ name: 'files' })

    // Assert
    expect(question).toContain('"files"')
    expect(question).toMatch(/agent/i)
  })

  test('a viewer sees only the two reading actions', () => {
    expect(actionIdsFor(SERVERS_SECTION, 'viewer')).toEqual(['list', 'show'])
  })

  test('an operator additionally sees refresh, which forces a probe', () => {
    expect(actionIdsFor(SERVERS_SECTION, 'operator')).toEqual(['list', 'show', 'refresh'])
  })

  test('an owner sees every action, add and remove included', () => {
    expect(actionIdsFor(SERVERS_SECTION, 'owner')).toEqual([
      'list',
      'show',
      'add',
      'refresh',
      'remove',
    ])
  })
})

describe('Vault keeps the secret out of every command line', () => {
  const cases: readonly {
    readonly id: string
    readonly values: FormValues
    readonly expected: readonly string[]
  }[] = [
    { id: 'list', values: {}, expected: ['vault', 'list'] },
    { id: 'init', values: {}, expected: ['vault', 'init'] },
    { id: 'set', values: { name: 'api-key', value: SECRET_SENTINEL }, expected: ['vault', 'set', 'api-key'] },
    { id: 'remove', values: { name: 'api-key' }, expected: ['vault', 'remove', 'api-key'] },
    { id: 'rekey', values: {}, expected: ['vault', 'rekey'] },
  ]

  test.each(cases)('$id turns the filled form into its argv', ({ id, values, expected }) => {
    // Arrange
    const action = actionOf(VAULT_SECTION, id)

    // Act
    const argv = action.argv(values)

    // Assert
    expect(argv).toEqual(expected)
  })

  test('set hands the value to stdin and asks nothing: a secret must not wait in a confirm pane', () => {
    // Arrange
    const action = actionOf(VAULT_SECTION, 'set')

    // Act & Assert
    expect(action.stdinField).toBe('value')
    expect(action.confirm).toBeUndefined()
  })

  test('no action of the section leaks a filled secret field into its argv', () => {
    for (const action of VAULT_SECTION.actions) {
      // Arrange
      const values = sentinelValuesOf(action)

      // Act
      const argv = action.argv(values)

      // Assert
      expect(
        argv.some((argument) => argument.includes(SECRET_SENTINEL)),
        `argv of ${action.id}`,
      ).toBe(false)
    }
  })

  test('the secret typed into set never reaches argv', () => {
    // Arrange
    const action = actionOf(VAULT_SECTION, 'set')

    // Act
    const argv = action.argv({ name: 'api-key', value: SECRET_SENTINEL })

    // Assert
    expect(argv).not.toContain(SECRET_SENTINEL)
  })

  test('remove names the secret and what stops resolving without it', () => {
    // Arrange
    const action = actionOf(VAULT_SECTION, 'remove')

    // Act
    const question = action.confirm?.({ name: 'api-key' })

    // Assert
    expect(question).toContain('"api-key"')
    expect(question).toContain('vault:api-key')
  })

  test('rekey asks before rotating the master key', () => {
    expect(actionOf(VAULT_SECTION, 'rekey').confirm?.({})).toMatch(/master key/i)
  })

  test('the whole section is owner-only, mirroring GET /vault', () => {
    expect(actionIdsFor(VAULT_SECTION, 'viewer')).toEqual([])
    expect(actionIdsFor(VAULT_SECTION, 'operator')).toEqual([])
    expect(actionIdsFor(VAULT_SECTION, 'owner')).toEqual(['list', 'init', 'set', 'remove', 'rekey'])
  })
})

describe('Policy builds the command lines `policy *` accepts', () => {
  const cases: readonly {
    readonly id: string
    readonly values: FormValues
    readonly expected: readonly string[]
  }[] = [
    { id: 'show', values: {}, expected: ['policy', 'show'] },
    {
      id: 'show-server',
      values: { server: 'files', 'entry-point': 'ui', json: 'true' },
      expected: ['policy', 'show', '--server', 'files', '--entry-point', 'ui', '--json'],
    },
    {
      id: 'validate',
      values: { path: '/etc/mcp/policy.json' },
      expected: ['policy', 'validate', '/etc/mcp/policy.json'],
    },
    {
      id: 'set',
      values: { server: 'files', tool: 'read_file', rule: 'require-approval' },
      expected: ['policy', 'set', 'files', 'read_file', 'require-approval'],
    },
  ]

  test.each(cases)('$id turns the filled form into its argv', ({ id, values, expected }) => {
    // Arrange
    const action = actionOf(POLICY_SECTION, id)

    // Act
    const argv = action.argv(values)

    // Assert
    expect(argv).toEqual(expected)
  })

  test('show --server omits the entry point when it was left at "any" and --json when off', () => {
    // Arrange
    const action = actionOf(POLICY_SECTION, 'show-server')
    const values: FormValues = { ...defaultValuesOf(action), server: 'files' }

    // Act
    const argv = action.argv(values)

    // Assert
    expect(argv).toEqual(['policy', 'show', '--server', 'files'])
  })

  test('validate with no path falls back to the resolved policy file', () => {
    // Arrange
    const action = actionOf(POLICY_SECTION, 'validate')

    // Act
    const argv = action.argv(defaultValuesOf(action))

    // Assert
    expect(argv).toEqual(['policy', 'validate'])
  })

  test('the rule field offers exactly the words the CLI accepts', () => {
    // Arrange
    const action = actionOf(POLICY_SECTION, 'set')

    // Act
    const rule = action.fields.find((field) => field.name === 'rule')

    // Assert
    expect(rule?.options).toEqual(['allow', 'require-approval', 'deny', 'clear'])
  })

  test('reading is open to a viewer while set is owner-only', () => {
    expect(actionIdsFor(POLICY_SECTION, 'viewer')).toEqual(['show', 'show-server', 'validate'])
    expect(actionIdsFor(POLICY_SECTION, 'operator')).toEqual(['show', 'show-server', 'validate'])
    expect(actionIdsFor(POLICY_SECTION, 'owner')).toEqual(['show', 'show-server', 'validate', 'set'])
  })
})

describe('Quarantine builds the command lines `quarantine *` accepts', () => {
  const cases: readonly {
    readonly id: string
    readonly values: FormValues
    readonly expected: readonly string[]
  }[] = [
    { id: 'list', values: {}, expected: ['quarantine', 'list'] },
    {
      id: 'show',
      values: { server: 'files', tool: 'read_file' },
      expected: ['quarantine', 'show', 'files', 'read_file'],
    },
    {
      id: 'approve',
      values: { server: 'files', tool: 'read_file' },
      expected: ['quarantine', 'approve', 'files', 'read_file'],
    },
    {
      id: 'approve-all',
      values: { server: 'files' },
      expected: ['quarantine', 'approve', '--all', '--server', 'files'],
    },
    {
      id: 'reject',
      values: { server: 'files', tool: 'read_file' },
      expected: ['quarantine', 'reject', 'files', 'read_file'],
    },
  ]

  test.each(cases)('$id turns the filled form into its argv', ({ id, values, expected }) => {
    // Arrange
    const action = actionOf(QUARANTINE_SECTION, id)

    // Act
    const argv = action.argv(values)

    // Assert
    expect(argv).toEqual(expected)
  })

  test('approve --all names the server whose whole backlog is being approved', () => {
    // Arrange
    const action = actionOf(QUARANTINE_SECTION, 'approve-all')

    // Act
    const question = action.confirm?.({ server: 'files' })

    // Assert
    expect(question).toContain('"files"')
  })

  test('reject names both the tool and the server, and says the tool is discarded', () => {
    // Arrange
    const action = actionOf(QUARANTINE_SECTION, 'reject')

    // Act
    const question = action.confirm?.({ server: 'files', tool: 'read_file' })

    // Assert
    expect(question).toContain('"read_file"')
    expect(question).toContain('"files"')
    expect(question).toMatch(/discard/i)
  })

  test('approving is an operator decision, reading is not', () => {
    expect(actionIdsFor(QUARANTINE_SECTION, 'viewer')).toEqual(['list', 'show'])
    expect(actionIdsFor(QUARANTINE_SECTION, 'operator')).toEqual([
      'list',
      'show',
      'approve',
      'approve-all',
      'reject',
    ])
  })
})

describe('every section of this task fits the 80-column screen', () => {
  const actions = SECTIONS_UNDER_TEST.flatMap((section) => section.actions)

  test.each(actions.map((action) => ({ id: action.id, title: action.title })))(
    '$id has a title the action column can print',
    ({ title }) => {
      expect(title.length).toBeLessThanOrEqual(ACTION_COLUMN_WIDTH - ACTIVE_MARKER.length)
    },
  )

  test('argv returns a fresh array on every call: nothing shares a command line', () => {
    for (const action of actions) {
      // Arrange
      const values = defaultValuesOf(action)

      // Act
      const first = action.argv(values)
      const second = action.argv(values)

      // Assert
      expect(first, `argv of ${action.id}`).not.toBe(second)
      expect(first, `argv of ${action.id}`).toEqual(second)
    }
  })

  test('every action names the command it runs at the head of its argv', () => {
    for (const action of actions) {
      // Arrange
      const head =
        action.subcommand === undefined ? [action.command] : [action.command, action.subcommand]

      // Act
      const argv = action.argv(defaultValuesOf(action))

      // Assert
      expect(argv.slice(0, head.length), `argv head of ${action.id}`).toEqual(head)
    }
  })

  test('the refresh action of every section is one that needs no form', () => {
    for (const section of SECTIONS_UNDER_TEST) {
      if (section.refreshActionId === undefined) continue

      // Act
      const action = actionOf(section, section.refreshActionId)

      // Assert
      expect(action.fields, `refresh of ${section.id}`).toEqual([])
    }
  })
})

/**
 * Owner tail Q26 (from the phase-4 smoke): registering a stdio server that
 * fetches over `npx` fails its probe behind a corporate proxy, because
 * `SYSTEM_ENV_ALLOWLIST` deliberately drops `HTTP(S)_PROXY`. The refusal is
 * true but gives no thread to pull, so both hints on `add` name the variable.
 * Pinned here because the hint IS the fix: prose that drifts back to a
 * generic "K=V,…" would leave the operator exactly where the smoke found them.
 */
describe('the Servers add form names the proxy variable (Q26)', () => {
  test('the Env field hint names HTTPS_PROXY', () => {
    const envField = actionOf(SERVERS_SECTION, 'add').fields.find((field) => field.name === 'env')

    expect(envField?.hint).toContain('HTTPS_PROXY')
  })

  test('the add action hint names HTTPS_PROXY too, beside the probe it explains', () => {
    const hint = actionOf(SERVERS_SECTION, 'add').hint

    expect(hint).toContain('HTTPS_PROXY')
  })
})

