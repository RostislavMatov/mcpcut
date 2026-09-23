import { describe, expect, test } from 'vitest'
import { DEFAULT_SERVE_HOST, DEFAULT_SERVE_PORT, MAX_TCP_PORT } from '../../src/cli/serve-constants.js'
import { DEFAULT_UI_HOST, DEFAULT_UI_PORT } from '../../src/cli/ui-constants.js'
import {
  InvalidBindEnvError,
  resolveServeDefaults,
  resolveUiDefaults,
} from '../../src/setup/bind.js'
import {
  INSTALL_CONFIG_VERSION,
  SERVE_HOST_ENV_VAR,
  SERVE_PORT_ENV_VAR,
  UI_HOST_ENV_VAR,
  UI_PORT_ENV_VAR,
} from '../../src/setup/constants.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'
import type { InstallConfig } from '../../src/setup/schema.js'

/**
 * The bind defaults each service falls back to when its flag is absent (phase
 * 1, task 5): `MCPCUT_<SVC>_<HOST|PORT>` > the install config > the historical
 * `DEFAULT_*` constants. The flags themselves outrank all three and are the
 * commands' own business (`tests/cli/ui-cmd.test.ts`).
 */

const CONFIG_PATH = '/home/op/.mcpcut/config.json'

function loadOf(config: Partial<InstallConfig>): InstallConfigLoad {
  return {
    kind: 'ok',
    path: CONFIG_PATH,
    config: {
      version: INSTALL_CONFIG_VERSION,
      dataDir: '/var/lib/mcpcut',
      ui: { host: '10.0.0.5', port: 9091 },
      serve: { host: '10.0.0.6', port: 9090 },
      ...config,
    } as InstallConfig,
  }
}

const ABSENT: InstallConfigLoad = { kind: 'absent', path: CONFIG_PATH }
const INVALID: InstallConfigLoad = { kind: 'invalid', path: CONFIG_PATH, problems: ['(root): broken'] }

describe('resolveUiDefaults', () => {
  test('falls back to the documented constants with no env and no config', () => {
    const defaults = resolveUiDefaults({}, ABSENT)

    expect(defaults).toEqual({ host: DEFAULT_UI_HOST, port: DEFAULT_UI_PORT })
  })

  test('an unusable config changes nothing: the constants still answer', () => {
    expect(resolveUiDefaults({}, INVALID)).toEqual({ host: DEFAULT_UI_HOST, port: DEFAULT_UI_PORT })
  })

  test('the config outranks the constants', () => {
    const defaults = resolveUiDefaults({}, loadOf({}))

    expect(defaults.host).toBe('10.0.0.5')
    expect(defaults.port).toBe(9091)
  })

  test('the environment outranks the config', () => {
    const defaults = resolveUiDefaults(
      { [UI_HOST_ENV_VAR]: '127.0.0.9', [UI_PORT_ENV_VAR]: '18091' },
      loadOf({}),
    )

    expect(defaults.host).toBe('127.0.0.9')
    expect(defaults.port).toBe(18091)
  })

  test('an empty environment value counts as not set, like every other env seam', () => {
    const defaults = resolveUiDefaults({ [UI_HOST_ENV_VAR]: '', [UI_PORT_ENV_VAR]: '' }, loadOf({}))

    expect(defaults.host).toBe('10.0.0.5')
    expect(defaults.port).toBe(9091)
  })

  test('port 0 from the environment stays legal: it means "any free port"', () => {
    expect(resolveUiDefaults({ [UI_PORT_ENV_VAR]: '0' }, ABSENT).port).toBe(0)
  })

  test('the hardening fields travel from the config, and only from it', () => {
    const defaults = resolveUiDefaults(
      {},
      loadOf({
        ui: {
          host: '10.0.0.5',
          port: 9091,
          behindTls: true,
          allowedHosts: ['plane.example'],
          allowedOrigins: ['https://plane.example'],
          trustedProxyHeader: 'x-forwarded-for',
        },
      }),
    )

    expect(defaults.behindTls).toBe(true)
    expect(defaults.allowedHosts).toEqual(['plane.example'])
    expect(defaults.allowedOrigins).toEqual(['https://plane.example'])
    expect(defaults.trustedProxyHeader).toBe('x-forwarded-for')
  })

  test('a config that omits the hardening fields leaves them absent, not defaulted', () => {
    const defaults = resolveUiDefaults({}, loadOf({}))

    expect(defaults.behindTls).toBeUndefined()
    expect(defaults.allowedHosts).toBeUndefined()
    expect(defaults.allowedOrigins).toBeUndefined()
    expect(defaults.trustedProxyHeader).toBeUndefined()
  })
})

describe('resolveServeDefaults', () => {
  test('falls back to the documented constants with no env and no config', () => {
    expect(resolveServeDefaults({}, ABSENT)).toEqual({
      host: DEFAULT_SERVE_HOST,
      port: DEFAULT_SERVE_PORT,
    })
  })

  test('the config outranks the constants and the environment outranks the config', () => {
    expect(resolveServeDefaults({}, loadOf({})).port).toBe(9090)
    expect(resolveServeDefaults({ [SERVE_PORT_ENV_VAR]: '18090' }, loadOf({})).port).toBe(18090)
    expect(resolveServeDefaults({ [SERVE_HOST_ENV_VAR]: '0.0.0.0' }, loadOf({})).host).toBe('0.0.0.0')
  })

  test('the policy path and the fail-closed switch travel from the config', () => {
    const defaults = resolveServeDefaults(
      {},
      loadOf({
        serve: {
          host: '10.0.0.6',
          port: 9090,
          failClosed: true,
          policy: '/etc/mcpcut/policy.json',
          allowedOrigins: ['https://agent.example'],
          allowedHosts: ['agent.example'],
        },
      }),
    )

    expect(defaults.failClosed).toBe(true)
    expect(defaults.policy).toBe('/etc/mcpcut/policy.json')
    expect(defaults.allowedOrigins).toEqual(['https://agent.example'])
    expect(defaults.allowedHosts).toEqual(['agent.example'])
  })
})

describe('resolveServeDefaults: serve.publicUrl (phase 4, C1)', () => {
  test('the remembered public address travels from the config', () => {
    const defaults = resolveServeDefaults(
      {},
      loadOf({ serve: { host: '10.0.0.6', port: 9090, publicUrl: 'https://mcp.example.com' } }),
    )

    expect(defaults.publicUrl).toBe('https://mcp.example.com')
  })

  test('an env port override moves the bind but never the public address', () => {
    const defaults = resolveServeDefaults(
      { [SERVE_PORT_ENV_VAR]: '18090' },
      loadOf({ serve: { host: '10.0.0.6', port: 9090, publicUrl: 'https://mcp.example.com' } }),
    )

    expect(defaults).toMatchObject({ port: 18090, publicUrl: 'https://mcp.example.com' })
  })

  test('absent in the config, absent in the defaults', () => {
    expect(resolveServeDefaults({}, loadOf({}))).not.toHaveProperty('publicUrl')
  })
})

describe('an unusable bind variable is refused, never silently ignored', () => {
  test('a non-numeric port names the variable and the accepted range', () => {
    expect(() => resolveUiDefaults({ [UI_PORT_ENV_VAR]: 'abc' }, ABSENT)).toThrow(InvalidBindEnvError)

    try {
      resolveUiDefaults({ [UI_PORT_ENV_VAR]: 'abc' }, ABSENT)
      expect.unreachable('the variable should have been refused')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidBindEnvError)
      expect((error as InvalidBindEnvError).variable).toBe(UI_PORT_ENV_VAR)
      expect((error as InvalidBindEnvError).message).toBe(
        `Invalid ${UI_PORT_ENV_VAR} "abc": expected 0..${MAX_TCP_PORT}.`,
      )
    }
  })

  test('a port above the TCP range is refused too', () => {
    expect(() => resolveServeDefaults({ [SERVE_PORT_ENV_VAR]: '70000' }, ABSENT)).toThrow(
      `Invalid ${SERVE_PORT_ENV_VAR} "70000": expected 0..${MAX_TCP_PORT}.`,
    )
  })

  test('a signed or fractional port is refused rather than truncated', () => {
    expect(() => resolveUiDefaults({ [UI_PORT_ENV_VAR]: '-1' }, ABSENT)).toThrow(InvalidBindEnvError)
    expect(() => resolveUiDefaults({ [UI_PORT_ENV_VAR]: '80.5' }, ABSENT)).toThrow(InvalidBindEnvError)
  })

  test('a config port is trusted: the schema already bounded it', () => {
    expect(() => resolveUiDefaults({}, loadOf({}))).not.toThrow()
  })
})
