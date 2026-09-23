import { describe, expect, test } from 'vitest'
import { overlaySetupArgs, parseSetupArgs } from '../../src/cli/setup-args.js'
import { TOKEN_ONCE_NOTICE } from '../../src/cli/ui-constants.js'
import { SUPERVISORS } from '../../src/setup/constants.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfig } from '../../src/setup/schema.js'
import { valuesOf, type FormValues } from '../../src/tui/form.js'
import {
  DEPLOY_STEP_ORDER,
  exposureWarningsOf,
  initialDeploySteps,
  isExternalSupervisor,
  MINTED_ADMIN_PREFIX,
  MINTED_TOKEN_PREFIX,
  mintedAdminOf,
  requestOf,
  setupArgvOf,
  WIZARD_FIELD,
  wizardFieldsOf,
  wizardScreenOf,
  type WizardPrefill,
} from '../../src/tui/wizard-fields.js'

/**
 * The wizard's form (mcpcut phase 3, Task 2): the eight answers a first run
 * collects, the `setup --yes` command line they build, the exposure findings
 * they raise, and the two lines of `setup`'s transcript that carry the first
 * admin back.
 *
 * Nothing here touches a disk or a socket — the fields are data and the argv
 * is a pure function of them — so the command the wizard would run is
 * asserted here, once, rather than through a deployed install.
 */

const DATA_DIR = '/var/lib/x'
const CONFIG_PATH = '/home/op/.mcpcut/config.json'

function prefillOf(config: InstallConfig = defaultInstallConfig(DATA_DIR)): WizardPrefill {
  return { mode: 'first-run', configPath: CONFIG_PATH, config }
}

function valuesFor(prefill: WizardPrefill = prefillOf()): FormValues {
  return valuesOf(wizardScreenOf(prefill).form)
}

function withValues(overrides: Readonly<Record<string, string>>): FormValues {
  return { ...valuesFor(), ...overrides }
}

/** The `validate` of one field, or a function that never objects when it has none. */
function validatorOf(prefill: WizardPrefill, name: string): (value: string) => string | undefined {
  const spec = wizardFieldsOf(prefill).find((field) => field.name === name)
  expect(spec, `no field named ${name}`).toBeDefined()

  return spec?.validate ?? (() => undefined)
}

describe('wizardFieldsOf: what the form starts with', () => {
  test('every value comes from the config the wizard was prefilled with', () => {
    const values = valuesFor()

    expect(values[WIZARD_FIELD.dataDir]).toBe(DATA_DIR)
    expect(values[WIZARD_FIELD.uiHost]).toBe('127.0.0.1')
    expect(values[WIZARD_FIELD.uiPort]).toBe('8091')
    expect(values[WIZARD_FIELD.serveHost]).toBe('127.0.0.1')
    expect(values[WIZARD_FIELD.servePort]).toBe('8090')
  })

  test('the TLS flag and the supervisor default to off and to this CLI', () => {
    const values = valuesFor()

    expect(values[WIZARD_FIELD.behindTls]).toBe('false')
    expect(values[WIZARD_FIELD.supervisor]).toBe(SUPERVISORS[0])
  })

  test('both come from the config when it carries them', () => {
    const base = defaultInstallConfig(DATA_DIR)
    const config: InstallConfig = {
      ...base,
      ui: { ...base.ui, behindTls: true },
      supervisor: 'external',
    }

    const values = valuesFor(prefillOf(config))

    expect(values[WIZARD_FIELD.behindTls]).toBe('true')
    expect(values[WIZARD_FIELD.supervisor]).toBe('external')
  })

  test('the first admin defaults to the bootstrap name and yields to the prefill', () => {
    expect(valuesFor()[WIZARD_FIELD.admin]).toBe('owner')

    const named = valuesFor({ ...prefillOf(), admin: 'ekaterina' })

    expect(named[WIZARD_FIELD.admin]).toBe('ekaterina')
  })

  test('every label fits the wizard label column, so no widget is pushed out', () => {
    for (const field of wizardFieldsOf(prefillOf())) {
      expect(field.label.length).toBeLessThanOrEqual(12)
    }
  })

  test('a fresh array of specs on every call', () => {
    expect(wizardFieldsOf(prefillOf())).not.toBe(wizardFieldsOf(prefillOf()))
  })
})

describe('the field validators', () => {
  test('a port must be a number the TCP range holds', () => {
    const validate = validatorOf(prefillOf(), WIZARD_FIELD.uiPort)

    expect(validate('0')).toBeUndefined()
    expect(validate('65535')).toBeUndefined()
    expect(validate('8O91')).toContain('0..65535')
    expect(validate('70000')).toContain('0..65535')
    expect(validate('')).toContain('0..65535')
  })

  test('both ports are checked the same way', () => {
    expect(validatorOf(prefillOf(), WIZARD_FIELD.servePort)('70000')).toContain('0..65535')
  })

  test('a data dir written with a tilde is refused, because no one expands it here', () => {
    const validate = validatorOf(prefillOf(), WIZARD_FIELD.dataDir)

    expect(validate('~/x')).toContain('~')
    expect(validate('/var/lib/x')).toBeUndefined()
  })

  test('a value that would read as a flag is refused where it was typed', () => {
    // `setupArgvOf` spells every answer out, so a leading dash reaches
    // `parseArgs` as the next option and the deploy dies with "ambiguous" —
    // a transcript that says nothing about the field it came from.
    expect(validatorOf(prefillOf(), WIZARD_FIELD.dataDir)('-/var/lib/x')).toContain(
      'write the full path',
    )
    expect(validatorOf(prefillOf(), WIZARD_FIELD.uiHost)('--ui-port')).toContain('host')
    expect(validatorOf(prefillOf(), WIZARD_FIELD.serveHost)('-h')).toContain('host')
  })

  test('a host that is merely unusual is still the operator\'s business', () => {
    expect(validatorOf(prefillOf(), WIZARD_FIELD.uiHost)('0.0.0.0')).toBeUndefined()
    expect(validatorOf(prefillOf(), WIZARD_FIELD.serveHost)('my-host.local')).toBeUndefined()
  })

  test('the admin name must match the pattern the store enforces', () => {
    const validate = validatorOf(prefillOf(), WIZARD_FIELD.admin)

    expect(validate('owner')).toBeUndefined()
    expect(validate('Owner')).toContain('match')
  })
})

describe('wizardScreenOf', () => {
  test('opens on the form stage, carrying the mode and the config path', () => {
    const screen = wizardScreenOf(prefillOf())

    expect(screen.kind).toBe('wizard')
    expect(screen.mode).toBe('first-run')
    expect(screen.configPath).toBe(CONFIG_PATH)
    expect(screen.stage).toEqual({ kind: 'form' })
    expect(screen.form.focus).toBe(0)
  })
})

describe('setupArgvOf: the command line the wizard would run', () => {
  test('is the full non-interactive setup, every answer spelled out', () => {
    expect(setupArgvOf(valuesFor())).toEqual([
      'setup',
      '--yes',
      '--data-dir',
      DATA_DIR,
      '--ui-host',
      '127.0.0.1',
      '--ui-port',
      '8091',
      '--serve-host',
      '127.0.0.1',
      '--serve-port',
      '8090',
      '--no-behind-tls',
      '--admin',
      'owner',
      '--supervisor',
      'mcpcut',
    ])
  })

  test('the TLS answer picks the flag that states it either way', () => {
    expect(setupArgvOf(withValues({ [WIZARD_FIELD.behindTls]: 'true' }))).toContain('--behind-tls')
    expect(setupArgvOf(withValues({ [WIZARD_FIELD.behindTls]: 'true' }))).not.toContain(
      '--no-behind-tls',
    )
  })

  test('a new array every call, so no caller can edit the last one', () => {
    const values = valuesFor()

    expect(setupArgvOf(values)).not.toBe(setupArgvOf(values))
    expect(setupArgvOf(values)).toEqual(setupArgvOf(values))
  })
})

describe('requestOf: one request per rung of the ladder', () => {
  test('the setup step runs the full setup argv', () => {
    const values = valuesFor()
    const request = requestOf('setup', values)

    expect(request.argv).toEqual(setupArgvOf(values))
    expect(request.actionId).toBe('setup')
  })

  test('each service step starts exactly that service', () => {
    expect(requestOf('start-ui', valuesFor()).argv).toEqual(['start', 'ui'])
    expect(requestOf('start-serve', valuesFor()).argv).toEqual(['start', 'serve'])
  })

  test('display is a copy of argv, never the same array', () => {
    const request = requestOf('start-ui', valuesFor())

    expect(request.display).toEqual([...request.argv])
    expect(request.display).not.toBe(request.argv)
  })
})

describe('exposureWarningsOf: what is said before anything is written', () => {
  test('a loopback bind on both services warns about nothing', () => {
    expect(exposureWarningsOf(valuesFor())).toEqual([])
    expect(exposureWarningsOf(withValues({ [WIZARD_FIELD.uiHost]: 'localhost' }))).toEqual([])
    expect(exposureWarningsOf(withValues({ [WIZARD_FIELD.uiHost]: '[::1]' }))).toEqual([])
  })

  test('a public UI bind warns once and points at the ADR that owns the model', () => {
    const warnings = exposureWarningsOf(withValues({ [WIZARD_FIELD.uiHost]: '0.0.0.0' }))

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('ADR-0004')
    expect(warnings[0]).toContain('ui binds 0.0.0.0')
  })

  test('a public bind on both services warns twice', () => {
    const warnings = exposureWarningsOf(
      withValues({ [WIZARD_FIELD.uiHost]: '0.0.0.0', [WIZARD_FIELD.serveHost]: '0.0.0.0' }),
    )

    expect(warnings).toHaveLength(2)
    expect(warnings[1]).toContain('serve binds 0.0.0.0')
  })

  test('declaring TLS changes the advice but not the warning', () => {
    const warnings = exposureWarningsOf(
      withValues({ [WIZARD_FIELD.uiHost]: '0.0.0.0', [WIZARD_FIELD.behindTls]: 'true' }),
    )

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('--behind-tls')
  })
})

describe('isExternalSupervisor', () => {
  test('is true only for the supervisor that runs the services elsewhere', () => {
    expect(isExternalSupervisor(valuesFor())).toBe(false)
    expect(isExternalSupervisor(withValues({ [WIZARD_FIELD.supervisor]: 'external' }))).toBe(true)
  })
})

describe('the deploy ladder', () => {
  test('runs setup first and both services after it, in that order', () => {
    expect([...DEPLOY_STEP_ORDER]).toEqual(['setup', 'start-ui', 'start-serve'])
  })

  test('starts with setup running and both starts pending', () => {
    expect(initialDeploySteps()).toEqual([
      { id: 'setup', state: 'running' },
      { id: 'start-ui', state: 'pending' },
      { id: 'start-serve', state: 'pending' },
    ])
  })

  test('the order is frozen, so no caller can reorder the rungs for everyone', () => {
    expect(Object.isFrozen(DEPLOY_STEP_ORDER)).toBe(true)
  })

  test('a fresh ladder every call, so a rerun never shows the marks of the last', () => {
    expect(initialDeploySteps()).not.toBe(initialDeploySteps())
  })
})

describe('mintedAdminOf: the first admin as setup reported it', () => {
  test('takes the name and the token out of a successful transcript', () => {
    const stdout = `admin: owner\nrole: owner\ntoken: mcpa_abc\n${TOKEN_ONCE_NOTICE}`

    expect(mintedAdminOf(stdout)).toEqual({ name: 'owner', token: 'mcpa_abc' })
  })

  test('finds them among the other lines setup prints', () => {
    const stdout = ['check  ui bind      ok', 'admin: ekaterina', 'token: mcpa_xyz', ''].join('\n')

    expect(mintedAdminOf(stdout)).toEqual({ name: 'ekaterina', token: 'mcpa_xyz' })
  })

  test('reports nothing when setup created no admin, however it phrased that', () => {
    expect(mintedAdminOf('admin: 1 admin(s) exist, none created\n')).toBeUndefined()
  })

  test('reports nothing for an empty transcript, or a token with no admin', () => {
    expect(mintedAdminOf('')).toBeUndefined()
    expect(mintedAdminOf('token: mcpa_abc\n')).toBeUndefined()
  })

  test('the two prefixes are the exact strings setup writes', () => {
    // Pinned so a rename in `setup-steps.ts` breaks this test rather than the
    // wizard's final screen, which would silently stop showing the token.
    expect(MINTED_ADMIN_PREFIX).toBe('admin: ')
    expect(MINTED_TOKEN_PREFIX).toBe('token: ')
  })
})

describe('the two optional addresses (2026-09-19)', () => {
  function valuesWith(extra: Record<string, string>): Record<string, string> {
    const base = Object.fromEntries(wizardFieldsOf(prefillOf()).map((field) => [field.name, field.initial ?? '']))
    return { ...base, ...extra }
  }

  test('left empty they add no flag, so an edit keeps every allow-list entry an earlier run wrote', () => {
    const argv = setupArgvOf(valuesWith({}))

    expect(argv).not.toContain('--ui-public-url')
    expect(argv).not.toContain('--serve-public-url')
  })

  test('filled in, each becomes its flag with the value trimmed', () => {
    const argv = setupArgvOf(valuesWith({ uiPublicUrl: ' http://203.0.113.7:8091 ', servePublicUrl: 'https://agents.example.com' }))

    expect(argv.slice(-4)).toEqual([
      '--ui-public-url',
      'http://203.0.113.7:8091',
      '--serve-public-url',
      'https://agents.example.com',
    ])
  })

  test('the agent address opens with the remembered serve.publicUrl (phase 4): an edit does not look empty', () => {
    const config = defaultInstallConfig(DATA_DIR)
    const remembered = { ...config, serve: { ...config.serve, publicUrl: 'https://agents.example.com' } }

    const values = valuesFor(prefillOf(remembered))

    expect(values[WIZARD_FIELD.servePublicUrl]).toBe('https://agents.example.com')
    expect(values[WIZARD_FIELD.uiPublicUrl]).toBe('')
    expect(setupArgvOf(values).slice(-2)).toEqual(['--serve-public-url', 'https://agents.example.com'])
  })

  test('without a remembered address the agent field opens empty and adds no flag', () => {
    const values = valuesFor()

    expect(values[WIZARD_FIELD.servePublicUrl]).toBe('')
    expect(setupArgvOf(values)).not.toContain('--serve-public-url')
  })

  test('a wizard pass that changes nothing leaves the serve config exactly as it was', () => {
    // The prefilled address goes back out as `--serve-public-url <same>`:
    // `applyPublicUrl` deduplicates the Host entry and the typed `--serve-host`
    // keeps the bind, so the round trip is a no-op.
    const config = defaultInstallConfig(DATA_DIR)
    const earlier: InstallConfig = {
      ...config,
      serve: {
        host: '0.0.0.0',
        port: 8090,
        allowedHosts: ['203.0.113.7:8090'],
        publicUrl: 'http://203.0.113.7:8090',
      },
    }
    const parsed = parseSetupArgs(setupArgvOf(valuesFor(prefillOf(earlier))).slice(1))
    if (!parsed.ok) throw new Error(parsed.message)

    expect(overlaySetupArgs(earlier, parsed.args, '/').serve).toEqual(earlier.serve)
  })

  test('they open empty, are not required, and refuse what `setup` would refuse — in its words', () => {
    const field = wizardFieldsOf(prefillOf()).find((each) => each.name === 'uiPublicUrl')

    expect(field?.initial).toBe('')
    expect(field?.required).toBeUndefined()
    expect(field?.validate?.('')).toBeUndefined()
    expect(field?.validate?.('http://203.0.113.7:8091')).toBeUndefined()
    expect(field?.validate?.('203.0.113.7:8091')).toContain('--ui-public-url')
  })
})
