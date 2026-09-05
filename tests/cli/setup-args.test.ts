import { describe, expect, test } from 'vitest'
import { parseSetupArgs, SETUP_USAGE } from '../../src/cli/setup-args.js'
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

describe('SETUP_USAGE', () => {
  test('shows the synopsis the plan fixed, so a refusal tells the operator what to type', () => {
    expect(SETUP_USAGE).toContain('mcpcut setup --yes')
    expect(SETUP_USAGE).toContain('--data-dir')
    expect(SETUP_USAGE).toContain('--admin <name>|--no-admin')
    expect(SETUP_USAGE).toContain('--supervisor mcpcut|external')
    // `--behind-tls` has no `--no-behind-tls`, so a rerun cannot take it back:
    // the synopsis has to say so where an operator reads the flags.
    expect(SETUP_USAGE).toContain('--behind-tls is remembered')
    expect(SETUP_USAGE.endsWith('\n')).toBe(true)
  })
})
