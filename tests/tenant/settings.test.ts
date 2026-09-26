import { describe, expect, test } from 'vitest'
import { MAX_AGENTS } from '../../src/agents/constants.js'
import { MAX_GROUPS } from '../../src/groups/constants.js'
import { MAX_SERVERS_IN_REGISTRY } from '../../src/registry/constants.js'
import type { InstallConfigLoad } from '../../src/setup/load.js'
import type { InstallConfig } from '../../src/setup/schema.js'
import { UpstreamAddressRefusedError } from '../../src/net/upstream-guard.js'
import {
  resolveTenantSettings,
  TENANT_SETTINGS,
  upstreamGuardFor,
  type TenantSettings,
} from '../../src/tenant/settings.js'

/**
 * Tenant mode settings (PRD `hosted-accounts`, phase 1, task 1, ADR-0017):
 * resolved once from the install config's `tenant` section, the same
 * RESOLVE-ONCE-AT-IMPORT shape `src/config.ts` uses for `JOURNAL_DIR`
 * (`tests/setup/data-dir.test.ts` is the model for testing that shape).
 */

const OK_BASE: InstallConfig = {
  version: 1,
  dataDir: '/var/lib/mcpcut',
  ui: { host: '127.0.0.1', port: 8091 },
  serve: { host: '127.0.0.1', port: 8090 },
}

function okLoad(tenant?: InstallConfig['tenant']): InstallConfigLoad {
  return {
    kind: 'ok',
    path: '/home/op/.mcpcut/config.json',
    config: tenant === undefined ? OK_BASE : { ...OK_BASE, tenant },
  }
}

const UNRESTRICTED: Omit<TenantSettings, 'isTenant'> = {
  stdioServers: 'allowed',
  upstreams: 'any',
  limits: { servers: MAX_SERVERS_IN_REGISTRY, agents: MAX_AGENTS, groups: MAX_GROUPS },
}

describe('resolveTenantSettings: no tenant section at all means prior behavior, byte for byte', () => {
  test('absent config', () => {
    const load: InstallConfigLoad = { kind: 'absent', path: '/home/op/.mcpcut/config.json' }

    expect(resolveTenantSettings(load)).toEqual({ isTenant: false, ...UNRESTRICTED })
  })

  test("invalid config: the dispatcher's own gate refuses the process before this value matters", () => {
    const load: InstallConfigLoad = {
      kind: 'invalid',
      path: '/home/op/.mcpcut/config.json',
      problems: ['(root): not valid JSON: the file does not parse as JSON'],
    }

    expect(resolveTenantSettings(load)).toEqual({ isTenant: false, ...UNRESTRICTED })
  })

  test('an ok config with no tenant key', () => {
    expect(resolveTenantSettings(okLoad())).toEqual({ isTenant: false, ...UNRESTRICTED })
  })
})

describe('resolveTenantSettings: an empty tenant section is the fully strict preset, not a no-op', () => {
  test('tenant: {} resolves to refused stdio, public-https-only, and the 5/5/2 limits', () => {
    const settings = resolveTenantSettings(okLoad({}))

    expect(settings).toEqual({
      isTenant: true,
      stdioServers: 'refused',
      upstreams: 'public-https',
      limits: { servers: 5, agents: 5, groups: 2 },
    })
  })
})

describe('resolveTenantSettings: a partial section keeps the strict default for every field it omits', () => {
  test('only stdioServers given: everything else falls back to strict, not to the unrestricted default', () => {
    const settings = resolveTenantSettings(okLoad({ stdioServers: 'allowed' }))

    expect(settings).toEqual({
      isTenant: true,
      stdioServers: 'allowed',
      upstreams: 'public-https',
      limits: { servers: 5, agents: 5, groups: 2 },
    })
  })

  test('only maxServers given', () => {
    const settings = resolveTenantSettings(okLoad({ maxServers: 40 }))

    expect(settings.limits).toEqual({ servers: 40, agents: 5, groups: 2 })
  })

  test('every field given explicitly is honored as-is', () => {
    const settings = resolveTenantSettings(
      okLoad({ stdioServers: 'allowed', upstreams: 'any', maxServers: 100, maxAgents: 50, maxGroups: 10 }),
    )

    expect(settings).toEqual({
      isTenant: true,
      stdioServers: 'allowed',
      upstreams: 'any',
      limits: { servers: 100, agents: 50, groups: 10 },
    })
  })

  test('maxGroups: 0 is legal (a hosted install with no groups at all)', () => {
    const settings = resolveTenantSettings(okLoad({ maxGroups: 0 }))

    expect(settings.limits.groups).toBe(0)
  })
})

describe('resolveTenantSettings: immutability', () => {
  test('the result and its limits are frozen', () => {
    const settings = resolveTenantSettings(okLoad({}))

    expect(Object.isFrozen(settings)).toBe(true)
    expect(Object.isFrozen(settings.limits)).toBe(true)
  })

  test('the unrestricted default is frozen too', () => {
    const settings = resolveTenantSettings({ kind: 'absent', path: '/x' })

    expect(Object.isFrozen(settings)).toBe(true)
    expect(Object.isFrozen(settings.limits)).toBe(true)
  })
})

describe('TENANT_SETTINGS: resolved once at import', () => {
  test('is a well-formed, frozen TenantSettings', () => {
    expect(Object.isFrozen(TENANT_SETTINGS)).toBe(true)
    expect(Object.isFrozen(TENANT_SETTINGS.limits)).toBe(true)
    expect(typeof TENANT_SETTINGS.isTenant).toBe('boolean')
    expect(['allowed', 'refused']).toContain(TENANT_SETTINGS.stdioServers)
    expect(['any', 'public-https']).toContain(TENANT_SETTINGS.upstreams)
  })
})

describe('upstreamGuardFor: the one place that decides "guard or not" (ADR-0017 T4)', () => {
  test('no tenant section: no guard, so every upstream is dialed exactly as before', () => {
    const settings = resolveTenantSettings({ kind: 'absent', path: '/x' })

    expect(upstreamGuardFor(settings)).toBeUndefined()
  })

  test('tenant mode with upstreams: any — no guard either', () => {
    const settings = resolveTenantSettings(okLoad({ upstreams: 'any' }))

    expect(upstreamGuardFor(settings)).toBeUndefined()
  })

  test('public-https (the strict default): a guard that refuses a loopback literal and plain http', () => {
    const guard = upstreamGuardFor(resolveTenantSettings(okLoad({})))

    expect(guard).toBeDefined()
    expect(() => guard?.checkUrl(new URL('https://127.0.0.1/mcp'))).toThrow(UpstreamAddressRefusedError)
    expect(() => guard?.checkUrl(new URL('http://example.com/mcp'))).toThrow(UpstreamAddressRefusedError)
    expect(() => guard?.checkUrl(new URL('https://example.com/mcp'))).not.toThrow()
  })
})
