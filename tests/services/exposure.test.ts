import { describe, expect, test } from 'vitest'
import { withExposure } from '../../src/services/exposure.js'
import type { ServiceStatus } from '../../src/services/manager-types.js'
import { checkBindExposure } from '../../src/setup/bind-checks.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfig } from '../../src/setup/schema.js'

/**
 * `status` names a bind other hosts can reach (Q31). The sentence is
 * `checkBindExposure`'s own, word for word — the one `setup` already prints —
 * so each expectation below is derived from it rather than retyped, and the
 * loopback cases pin identity: an install with nothing to warn about must
 * produce the very same status object, so its `--json` stays byte-for-byte.
 */

const CONFIG: InstallConfig = defaultInstallConfig('/var/lib/mcpcut')

const UI_STATUS: ServiceStatus = {
  service: 'ui',
  state: 'running',
  host: '0.0.0.0',
  port: 8091,
  pid: 4242,
  logPath: '/var/lib/mcpcut/run/ui.log',
}

const SERVE_STATUS: ServiceStatus = {
  service: 'serve',
  state: 'stopped',
  host: '0.0.0.0',
  port: 8090,
  logPath: '/var/lib/mcpcut/run/serve.log',
}

describe('withExposure', () => {
  test('a wildcard bind carries a warn with the setup preflight detail word for word', () => {
    const status = withExposure(CONFIG, UI_STATUS)

    expect(status).toEqual({
      ...UI_STATUS,
      exposure: { level: 'warn', detail: checkBindExposure('ui', '0.0.0.0', false).detail },
    })
    expect(status.exposure?.detail).toBe(
      'ui binds 0.0.0.0: reachable from the network. Terminate TLS in front ' +
        "(ui: --behind-tls + --allowed-host; serve: agents' bearer tokens travel in clear otherwise) — ADR-0004",
    )
  })

  test.each(['127.0.0.1', '::1', 'localhost'])('a loopback bind (%s) returns the same object', (host) => {
    const status: ServiceStatus = { ...UI_STATUS, host }

    const result = withExposure(CONFIG, status)

    expect(result).toBe(status)
    expect('exposure' in result).toBe(false)
  })

  test('a ui declared behind TLS still warns, with the TLS-declared advice', () => {
    const config: InstallConfig = { ...CONFIG, ui: { ...CONFIG.ui, behindTls: true } }

    const status = withExposure(config, UI_STATUS)

    expect(status.exposure).toEqual({
      level: 'warn',
      detail:
        'ui binds 0.0.0.0: reachable from the network. TLS is declared (--behind-tls), so make sure ' +
        'a terminating proxy really is in front and --allowed-host names it — ADR-0004',
    })
  })

  test("serve ignores the ui's TLS declaration", () => {
    const config: InstallConfig = { ...CONFIG, ui: { ...CONFIG.ui, behindTls: true } }

    const status = withExposure(config, SERVE_STATUS)

    expect(status.exposure).toEqual({
      level: 'warn',
      detail: checkBindExposure('serve', '0.0.0.0', false).detail,
    })
  })

  test('judges the status host, not the config bind', () => {
    // With a pid file the status host is the record's: that is where the
    // process actually listens, whatever the config says today.
    const status = withExposure(CONFIG, { ...SERVE_STATUS, host: '10.0.0.5' })

    expect(status.exposure?.detail.startsWith('serve binds 10.0.0.5: reachable from the network.')).toBe(true)
  })

  test('does not mutate the status it was given', () => {
    const status: ServiceStatus = { ...UI_STATUS }

    withExposure(CONFIG, status)

    expect(status).toEqual(UI_STATUS)
    expect('exposure' in status).toBe(false)
  })
})
