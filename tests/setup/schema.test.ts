import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { INSTALL_CONFIG_VERSION, MAX_CONFIG_STRING_LENGTH, MAX_LIST_ENTRIES } from '../../src/setup/constants.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import { formatInstallConfigErrors, installConfigSchema } from '../../src/setup/schema.js'

/**
 * The install config's schema (phase 1, task 2). It is the only guard between
 * a hand-edited `~/.mcpcut/config.json` and every process that resolves its
 * data directory from it, so the tests pin the refusals by their text: those
 * lines are what an operator sees when a command declines to start.
 */

function validConfig(): Record<string, unknown> {
  return {
    version: INSTALL_CONFIG_VERSION,
    dataDir: '/var/lib/mcpcut',
    ui: { host: '127.0.0.1', port: 8091 },
    serve: { host: '127.0.0.1', port: 8090 },
  }
}

function problemsOf(value: unknown): readonly string[] {
  const parsed = installConfigSchema.safeParse(value)
  expect(parsed.success).toBe(false)
  return formatInstallConfigErrors((parsed as { error: z.ZodError }).error)
}

describe('installConfigSchema: the shape it accepts', () => {
  test('accepts a minimal config carrying only the version, the data dir and both binds', () => {
    const parsed = installConfigSchema.safeParse(validConfig())

    expect(parsed.success).toBe(true)
  })

  test('accepts every optional wiring field the services forward as flags', () => {
    const parsed = installConfigSchema.safeParse({
      ...validConfig(),
      ui: {
        host: '0.0.0.0',
        port: 8091,
        behindTls: true,
        allowedHosts: ['plane.example.com'],
        allowedOrigins: ['https://plane.example.com'],
        trustedProxyHeader: 'x-forwarded-for',
      },
      serve: {
        host: '127.0.0.1',
        port: 8090,
        allowedHosts: ['plane.example.com'],
        allowedOrigins: ['https://plane.example.com'],
        failClosed: true,
        policy: '/etc/mcpcut/policy.json',
      },
      supervisor: 'external',
    })

    expect(parsed.success).toBe(true)
  })

  test('accepts the config the installer writes for a fresh data directory', () => {
    const parsed = installConfigSchema.safeParse(defaultInstallConfig('/x'))

    expect(parsed.success).toBe(true)
  })
})

describe('installConfigSchema: the refusals', () => {
  test('refuses a config whose dataDir is relative and names the field', () => {
    expect(problemsOf({ ...validConfig(), dataDir: 'data' })).toContain(
      'dataDir: dataDir must be an absolute path',
    )
  })

  test('refuses an empty dataDir', () => {
    expect(problemsOf({ ...validConfig(), dataDir: '' }).join('\n')).toContain('dataDir:')
  })

  test('refuses an unknown key and names it, so no token can hide in the config', () => {
    expect(problemsOf({ ...validConfig(), ui: { host: '127.0.0.1', port: 8091, token: 'mcpa_x' } })).toContain(
      'ui: unknown key "token"',
    )
  })

  test('refuses an unknown key at the root as well', () => {
    expect(problemsOf({ ...validConfig(), password: 'hunter2' })).toContain(
      '(root): unknown key "password"',
    )
  })

  test('refuses a port above the highest TCP port', () => {
    expect(problemsOf({ ...validConfig(), ui: { host: '127.0.0.1', port: 70000 } }).join('\n')).toContain(
      'ui.port:',
    )
  })

  test('refuses a port that is not an integer', () => {
    expect(problemsOf({ ...validConfig(), serve: { host: '127.0.0.1', port: 80.5 } }).join('\n')).toContain(
      'serve.port:',
    )
  })

  test('refuses an empty host', () => {
    expect(problemsOf({ ...validConfig(), ui: { host: '', port: 8091 } }).join('\n')).toContain('ui.host:')
  })

  test('accepts a probeHost on either service: the address a pid-less status dials', () => {
    const parsed = installConfigSchema.safeParse({
      ...validConfig(),
      ui: { host: '0.0.0.0', port: 8091, probeHost: 'ui' },
      serve: { host: '0.0.0.0', port: 8090, probeHost: 'serve' },
    })

    expect(parsed.success).toBe(true)
  })

  test('refuses an empty probeHost', () => {
    expect(problemsOf({ ...validConfig(), ui: { host: '0.0.0.0', port: 8091, probeHost: '' } }).join('\n')).toContain(
      'ui.probeHost:',
    )
  })

  test('refuses a probeHost longer than a DNS name can be', () => {
    const tooLong = 'a'.repeat(254)

    expect(
      problemsOf({ ...validConfig(), serve: { host: '0.0.0.0', port: 8090, probeHost: tooLong } }).join('\n'),
    ).toContain('serve.probeHost:')
  })

  test('an unknown key beside probeHost is still refused', () => {
    expect(
      problemsOf({ ...validConfig(), ui: { host: '0.0.0.0', port: 8091, probeHost: 'ui', probe: 'x' } }),
    ).toContain('ui: unknown key "probe"')
  })

  test('refuses the literal origin "null": the opaque origin can never be allowed', () => {
    const problems = problemsOf({
      ...validConfig(),
      ui: { host: '127.0.0.1', port: 8091, allowedOrigins: ['null'] },
    })

    expect(problems.join('\n')).toContain('ui.allowedOrigins.0:')
  })

  test('refuses the literal origin "null" on the serve bind too', () => {
    const problems = problemsOf({
      ...validConfig(),
      serve: { host: '127.0.0.1', port: 8090, allowedOrigins: ['null'] },
    })

    expect(problems.join('\n')).toContain('serve.allowedOrigins.0:')
  })

  test('refuses a string list longer than the bound', () => {
    const tooMany = Array.from({ length: MAX_LIST_ENTRIES + 1 }, (_unused, index) => `host-${index}.example.com`)

    expect(
      problemsOf({ ...validConfig(), ui: { host: '127.0.0.1', port: 8091, allowedHosts: tooMany } }).join('\n'),
    ).toContain('ui.allowedHosts:')
  })

  test('refuses a version it does not know', () => {
    expect(problemsOf({ ...validConfig(), version: 2 }).join('\n')).toContain('version:')
  })

  test('refuses a supervisor outside the known set', () => {
    expect(problemsOf({ ...validConfig(), supervisor: 'systemd' }).join('\n')).toContain('supervisor:')
  })

  test('names the root when the whole document is not an object', () => {
    expect(problemsOf('nope').join('\n')).toContain('(root):')
  })
})

describe('installConfigSchema: serve.publicUrl (phase 4, C1)', () => {
  // The address `agent create` puts into every client config. `setup` writes the
  // WHATWG origin of a parsed `--serve-public-url`; the pattern only keeps a
  // hand-edited config from smuggling a path, a query, credentials or a space
  // into the block an operator pastes.
  function withServePublicUrl(publicUrl: unknown): Record<string, unknown> {
    return { ...validConfig(), serve: { host: '127.0.0.1', port: 8090, publicUrl } }
  }

  test.each(['http://127.0.0.1:8090', 'https://mcp.example.com', 'http://[::1]:8090', 'HTTPS://MCP.EXAMPLE.COM'])(
    'accepts the origin %s',
    (publicUrl) => {
      expect(installConfigSchema.safeParse(withServePublicUrl(publicUrl)).success).toBe(true)
    },
  )

  test.each([
    'https://h/mcp',
    'http://h:8090/',
    'ftp://h',
    'h:8090',
    'http://u:p@h',
    ' http://h',
    'http://h ',
    'http://h?x=1',
    'http://h#x',
    // WHATWG reads a backslash as a slash in special schemes: a path in disguise.
    'https://good.example\\x',
    '',
  ])('refuses %j and names the field', (publicUrl) => {
    expect(problemsOf(withServePublicUrl(publicUrl)).join('\n')).toContain('serve.publicUrl:')
  })

  test('says what an origin is when it refuses a path', () => {
    expect(problemsOf(withServePublicUrl('https://h/mcp'))).toContain(
      'serve.publicUrl: must be an origin: http(s)://host[:port], no path',
    )
  })

  test('refuses a publicUrl longer than the free-form string bound', () => {
    const long = `https://${'a'.repeat(MAX_CONFIG_STRING_LENGTH)}`

    expect(problemsOf(withServePublicUrl(long)).join('\n')).toContain('serve.publicUrl:')
  })

  test('refuses publicUrl on the ui: nothing reads it there (C1)', () => {
    expect(
      problemsOf({ ...validConfig(), ui: { host: '127.0.0.1', port: 8091, publicUrl: 'https://h' } }),
    ).toContain('ui: unknown key "publicUrl"')
  })
})

describe('defaultInstallConfig', () => {
  test('binds the ui to loopback 8091 and serve to loopback 8090', () => {
    const config = defaultInstallConfig('/srv/plane')

    expect(config).toEqual({
      version: INSTALL_CONFIG_VERSION,
      dataDir: '/srv/plane',
      ui: { host: '127.0.0.1', port: 8091 },
      serve: { host: '127.0.0.1', port: 8090 },
    })
  })
})
