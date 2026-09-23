import { describe, expect, test } from 'vitest'
import {
  NO_SETUP_ARGS,
  overlaySetupArgs,
  parseSetupArgs,
  SETUP_USAGE,
  type SetupArgs,
} from '../../src/cli/setup-args.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfig } from '../../src/setup/schema.js'
import { MAX_TCP_PORT } from '../../src/cli/serve-constants.js'

/**
 * The argument layer of `mcpcut setup` (phase 1, Task 14). Split from
 * `setup-cmd.ts` the way `server-add-args.ts` is split from `server-cmd.ts`:
 * argv in, a value out, no disk and no streams — so every refusal below is a
 * pure assertion about a string.
 */

describe('parseSetupArgs: the flags a non-interactive install is described by', () => {
  test('parses every flag of a fully specified run', () => {
    const parsed = parseSetupArgs([
      '--yes',
      '--force',
      '--start',
      '--behind-tls',
      '--data-dir',
      '/var/lib/mcpcut',
      '--ui-host',
      '0.0.0.0',
      '--ui-port',
      '9001',
      '--serve-host',
      '127.0.0.1',
      '--serve-port',
      '9002',
      '--admin',
      'ops',
      '--supervisor',
      'external',
      '--ui-probe-host',
      'ui',
      '--serve-probe-host',
      'serve',
    ])

    expect(parsed).toEqual({
      ok: true,
      args: {
        yes: true,
        force: true,
        start: true,
        noAdmin: false,
        behindTls: true,
        dataDir: '/var/lib/mcpcut',
        uiHost: '0.0.0.0',
        uiPort: 9001,
        serveHost: '127.0.0.1',
        servePort: 9002,
        admin: 'ops',
        supervisor: 'external',
        uiProbeHost: 'ui',
        serveProbeHost: 'serve',
      },
    })
  })

  test('leaves every flag that was not given absent, so nothing is overlaid by accident', () => {
    const parsed = parseSetupArgs(['--yes'])

    expect(parsed).toEqual({
      ok: true,
      args: { yes: true, force: false, start: false, noAdmin: false },
    })
  })

  test('accepts an empty argv: the missing --yes is the command\'s refusal, not the parser\'s', () => {
    const parsed = parseSetupArgs([])

    expect(parsed).toEqual({ ok: true, args: { yes: false, force: false, start: false, noAdmin: false } })
  })

  test('refuses an unknown flag and names it', () => {
    const parsed = parseSetupArgs(['--yes', '--datadir', '/tmp/x'])

    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected a refusal')
    expect(parsed.message).toContain('--datadir')
  })

  test('refuses a positional argument: setup takes flags only', () => {
    const parsed = parseSetupArgs(['--yes', 'install'])

    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected a refusal')
    expect(parsed.message).toContain('install')
  })

  test('refuses a non-numeric port and names the flag and the value', () => {
    const parsed = parseSetupArgs(['--yes', '--ui-port', 'abc'])

    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected a refusal')
    expect(parsed.message).toBe(`Invalid --ui-port "abc": expected 0..${MAX_TCP_PORT}.`)
  })

  test('refuses a port above the highest legal one', () => {
    const parsed = parseSetupArgs(['--yes', '--serve-port', '70000'])

    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected a refusal')
    expect(parsed.message).toBe(`Invalid --serve-port "70000": expected 0..${MAX_TCP_PORT}.`)
  })

  test('accepts port 0: "any free port" is legal here exactly as it is for the flags', () => {
    const parsed = parseSetupArgs(['--yes', '--ui-port', '0'])

    expect(parsed).toEqual({
      ok: true,
      args: { yes: true, force: false, start: false, noAdmin: false, uiPort: 0 },
    })
  })

  test('refuses a supervisor that is not one of the two and lists them', () => {
    const parsed = parseSetupArgs(['--yes', '--supervisor', 'systemd'])

    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected a refusal')
    expect(parsed.message).toBe('Invalid --supervisor "systemd": expected one of mcpcut, external.')
  })

  test('records --no-behind-tls as an explicit false, so a rerun can take the claim back', () => {
    const parsed = parseSetupArgs(['--yes', '--no-behind-tls'])

    expect(parsed).toEqual({
      ok: true,
      args: { yes: true, force: false, start: false, noAdmin: false, behindTls: false },
    })
  })

  test('refuses --behind-tls together with --no-behind-tls: they ask for opposite things', () => {
    const parsed = parseSetupArgs(['--yes', '--behind-tls', '--no-behind-tls'])

    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected a refusal')
    expect(parsed.message).toContain('--behind-tls')
    expect(parsed.message).toContain('--no-behind-tls')
  })

  test('refuses --admin together with --no-admin: they ask for opposite things', () => {
    const parsed = parseSetupArgs(['--yes', '--admin', 'ops', '--no-admin'])

    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected a refusal')
    expect(parsed.message).toContain('--admin')
    expect(parsed.message).toContain('--no-admin')
  })

  test('a control character in a flag value cannot reach the terminal raw', () => {
    const parsed = parseSetupArgs(['--yes', '--supervisor', 'ext[31mernal'])

    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('expected a refusal')
    expect(parsed.message).not.toContain('')
  })
})


describe('overlaySetupArgs: the flags the operator typed, laid over the config that exists', () => {
  const base: InstallConfig = {
    ...defaultInstallConfig('/var/lib/mcpcut'),
    ui: {
      ...defaultInstallConfig('/var/lib/mcpcut').ui,
      host: '127.0.0.1',
      port: 7777,
      behindTls: true,
      allowedHosts: ['mcpcut.example'],
    },
  }

  test('overlays only the fields that were given', () => {
    const overlaid = overlaySetupArgs(base, { ...NO_SETUP_ARGS, uiPort: 9001 }, '/work')

    expect(overlaid.ui.port).toBe(9001)
    expect(overlaid.ui.host).toBe('127.0.0.1')
    expect(overlaid.dataDir).toBe(base.dataDir)
    expect(overlaid.serve).toEqual(base.serve)
  })

  test('NO_SETUP_ARGS changes nothing at all', () => {
    expect(overlaySetupArgs(base, NO_SETUP_ARGS, '/work')).toEqual(base)
  })

  test('writes behindTls: false, so --no-behind-tls can take the claim back', () => {
    const args: SetupArgs = { ...NO_SETUP_ARGS, behindTls: false }

    expect(overlaySetupArgs(base, args, '/work').ui.behindTls).toBe(false)
  })

  test('resolves a relative --data-dir against the cwd and leaves an absolute one alone', () => {
    expect(overlaySetupArgs(base, { ...NO_SETUP_ARGS, dataDir: 'data' }, '/work').dataDir).toBe(
      '/work/data',
    )
    expect(overlaySetupArgs(base, { ...NO_SETUP_ARGS, dataDir: '/srv/d' }, '/work').dataDir).toBe(
      '/srv/d',
    )
  })

  test('fields setup has no flag for survive the overlay', () => {
    const overlaid = overlaySetupArgs(
      base,
      {
        ...NO_SETUP_ARGS,
        uiHost: '0.0.0.0',
        serveHost: '0.0.0.0',
        servePort: 9002,
        supervisor: 'external',
      },
      '/work',
    )

    expect(overlaid.ui.allowedHosts).toEqual(['mcpcut.example'])
    expect(overlaid.ui.behindTls).toBe(true)
    expect(overlaid.ui.host).toBe('0.0.0.0')
    expect(overlaid.serve.host).toBe('0.0.0.0')
    expect(overlaid.serve.port).toBe(9002)
    expect(overlaid.supervisor).toBe('external')
  })

  test('--serve-probe-host alone writes serve.probeHost and nothing else', () => {
    const overlaid = overlaySetupArgs(base, { ...NO_SETUP_ARGS, serveProbeHost: 'serve' }, '/work')

    expect(overlaid).toEqual({ ...base, serve: { ...base.serve, probeHost: 'serve' } })
  })

  test('--ui-probe-host alone writes ui.probeHost and nothing else', () => {
    const overlaid = overlaySetupArgs(base, { ...NO_SETUP_ARGS, uiProbeHost: 'ui' }, '/work')

    expect(overlaid).toEqual({ ...base, ui: { ...base.ui, probeHost: 'ui' } })
  })

  test('a probeHost an earlier run wrote survives a rerun that does not mention it', () => {
    const withProbe: InstallConfig = {
      ...base,
      ui: { ...base.ui, probeHost: 'ui' },
      serve: { ...base.serve, probeHost: 'serve' },
    }

    const overlaid = overlaySetupArgs(withProbe, { ...NO_SETUP_ARGS, uiHost: '0.0.0.0', servePort: 9002 }, '/work')

    expect(overlaid.ui.probeHost).toBe('ui')
    expect(overlaid.serve.probeHost).toBe('serve')
  })

  test('never mutates the config it was handed', () => {
    const snapshot = structuredClone(base)

    overlaySetupArgs(base, { ...NO_SETUP_ARGS, uiPort: 9001, dataDir: 'data' }, '/work')

    expect(base).toEqual(snapshot)
  })
})

describe('SETUP_USAGE', () => {
  test('shows the synopsis the plan fixed, so a refusal tells the operator what to type', () => {
    expect(SETUP_USAGE).toContain('mcpcut setup --yes')
    expect(SETUP_USAGE).toContain('--data-dir')
    expect(SETUP_USAGE).toContain('--admin <name>|--no-admin')
    expect(SETUP_USAGE).toContain('--supervisor mcpcut|external')
    // `--behind-tls` survives a rerun that does not mention it, so the synopsis
    // has to name the flag that takes it back where an operator reads the flags.
    expect(SETUP_USAGE).toContain('--behind-tls|--no-behind-tls')
    expect(SETUP_USAGE).toContain('--behind-tls is remembered')
    expect(SETUP_USAGE).toContain('[--ui-probe-host H] [--serve-probe-host H]')
    expect(SETUP_USAGE.endsWith('\n')).toBe(true)
  })
})

describe('--ui-public-url / --serve-public-url: one address instead of three flags', () => {
  const BASE: InstallConfig = defaultInstallConfig('/var/lib/mcpcut')

  function parsedArgs(argv: readonly string[]): SetupArgs {
    const parsed = parseSetupArgs(['--yes', ...argv])
    if (!parsed.ok) throw new Error(parsed.message)
    return parsed.args
  }

  function overlaid(argv: readonly string[]): InstallConfig {
    return overlaySetupArgs(BASE, parsedArgs(argv), '/')
  }

  test('http by IP: bind opened, Host and Origin allowed, no TLS claimed', () => {
    const { ui } = overlaid(['--ui-public-url', 'http://203.0.113.7:8091'])

    expect(ui).toMatchObject({
      host: '0.0.0.0',
      behindTls: false,
      allowedHosts: ['203.0.113.7:8091'],
      allowedOrigins: ['http://203.0.113.7:8091'],
    })
  })

  test('https by name: TLS in front is recorded and the bind stays on loopback', () => {
    const { ui } = overlaid(['--ui-public-url', 'https://mcp.example.com'])

    expect(ui).toMatchObject({ host: '127.0.0.1', behindTls: true, allowedHosts: ['mcp.example.com'] })
  })

  test('explicit flags win over what the URL would have derived', () => {
    const { ui } = overlaid(['--ui-public-url', 'https://mcp.example.com', '--no-behind-tls', '--ui-host', '10.0.0.5'])

    expect(ui).toMatchObject({ host: '10.0.0.5', behindTls: false })
  })

  test('the serve address opens the agent front the same way, without origins', () => {
    const { serve, ui } = overlaid(['--serve-public-url', 'http://203.0.113.7:8090'])

    expect(serve).toMatchObject({ host: '0.0.0.0', allowedHosts: ['203.0.113.7:8090'] })
    expect(serve.allowedOrigins).toBeUndefined()
    expect(ui).toEqual(BASE.ui)
  })

  test('the serve address is remembered as serve.publicUrl: the address generated client configs carry', () => {
    const { serve } = overlaid(['--serve-public-url', 'http://203.0.113.7:8090'])

    expect(serve).toMatchObject({
      host: '0.0.0.0',
      allowedHosts: ['203.0.113.7:8090'],
      publicUrl: 'http://203.0.113.7:8090',
    })
  })

  test('the remembered address is the WHATWG origin: the default port is dropped the way the bridge and Host drop it', () => {
    const { serve } = overlaid(['--serve-public-url', 'https://MCP.Example.com:443'])

    expect(serve.publicUrl).toBe('https://mcp.example.com')
  })

  test('the ui address is not remembered: nothing reads it (C1)', () => {
    const { serve, ui } = overlaid(['--ui-public-url', 'https://mcp.example.com'])

    expect(serve.publicUrl).toBeUndefined()
    expect(ui).not.toHaveProperty('publicUrl')
  })

  test('a rerun that does not type the flag keeps the remembered address', () => {
    const base: InstallConfig = { ...BASE, serve: { ...BASE.serve, publicUrl: 'https://mcp.example.com' } }
    const parsed = parseSetupArgs(['--yes', '--serve-port', '9000'])
    if (!parsed.ok) throw new Error(parsed.message)

    expect(overlaySetupArgs(base, parsed.args, '/').serve).toMatchObject({
      port: 9000,
      publicUrl: 'https://mcp.example.com',
    })
  })

  test('a rerun with another address replaces publicUrl but adds to the allow-list', () => {
    const first = overlaySetupArgs(BASE, parsedArgs(['--serve-public-url', 'https://a.example.com']), '/')
    const second = overlaySetupArgs(first, parsedArgs(['--serve-public-url', 'https://b.example.com']), '/')

    expect(second.serve.publicUrl).toBe('https://b.example.com')
    expect(second.serve.allowedHosts).toEqual(['a.example.com', 'b.example.com'])
  })

  test('a malformed address refuses the run before anything is written', () => {
    const parsed = parseSetupArgs(['--yes', '--ui-public-url', '203.0.113.7:8091'])

    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.message).toContain('--ui-public-url')
  })

  test('the usage names both flags', () => {
    expect(SETUP_USAGE).toContain('--ui-public-url <url>')
    expect(SETUP_USAGE).toContain('--serve-public-url <url>')
  })
})
