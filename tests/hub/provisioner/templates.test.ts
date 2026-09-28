import { describe, expect, test } from 'vitest'
import {
  adminNameOf,
  bridgeInterfaceName,
  containerSpec,
  isTenantLogin,
  isTenantSubdomain,
  MAX_TENANT_SUBDOMAIN_LENGTH,
  TENANT_BRIDGE_PREFIX,
  TENANT_HOME_MOUNT,
  TENANT_LABEL,
  LOGIN_LABEL,
  tenantLabels,
  tenantNames,
  tenantNetworkOptions,
  tenantPublicUrl,
} from '../../../hub/src/provisioner/templates.js'

/**
 * The fixed templates (plan `tenant-orchestrator`, Task 4, O3/O4): every
 * Docker object a tenant gets is spelled here and nowhere else, so these
 * tests are the review surface for "what does a tenant container look like".
 */

const INPUT = { subdomain: 'alice', login: 'Alice', image: 'mcpcut-tenant:local', publicDomain: 'mcpcut.com' }
const MIB = 1024 * 1024

describe('tenant names', () => {
  test('container, network and volume share the mcpcut-t- prefix', () => {
    expect(tenantNames('alice')).toEqual({
      container: 'mcpcut-t-alice',
      network: 'mcpcut-t-alice',
      volume: 'mcpcut-t-alice',
    })
  })

  test('refuses a subdomain that is not a valid one', () => {
    expect(() => tenantNames('../etc')).toThrow(TypeError)
  })
})

describe('isTenantSubdomain', () => {
  test.each(['alice', 'a', 'bob-2', 'x'.repeat(MAX_TENANT_SUBDOMAIN_LENGTH)])('accepts %s', (sub) => {
    expect(isTenantSubdomain(sub)).toBe(true)
  })

  test.each([
    '',
    'Alice',
    '-alice',
    'alice-',
    'al_ice',
    'a.b',
    'x'.repeat(MAX_TENANT_SUBDOMAIN_LENGTH + 1),
    'www',
    'mcp',
    'hub',
    'admin',
  ])('refuses %j', (sub) => {
    expect(isTenantSubdomain(sub)).toBe(false)
  })

  test('the container name stays one DNS label, so Caddy can resolve it', () => {
    const longest = tenantNames('x'.repeat(MAX_TENANT_SUBDOMAIN_LENGTH)).container
    expect(longest.length).toBeLessThanOrEqual(63)
  })

  test('refuses a non-string', () => {
    expect(isTenantSubdomain(42 as unknown as string)).toBe(false)
  })
})

describe('bridgeInterfaceName (fix `tenant-network-isolation`)', () => {
  test('starts with the fixed prefix and is at most 15 characters (Linux IFNAMSIZ)', () => {
    const name = bridgeInterfaceName('alice')

    expect(name.startsWith(TENANT_BRIDGE_PREFIX)).toBe(true)
    expect(name.length).toBeLessThanOrEqual(15)
  })

  test('is stable for the same subdomain', () => {
    expect(bridgeInterfaceName('alice')).toBe(bridgeInterfaceName('alice'))
  })

  test('differs for different subdomains', () => {
    expect(bridgeInterfaceName('alice')).not.toBe(bridgeInterfaceName('bob'))
  })

  test('is at most 15 characters even for the longest allowed subdomain', () => {
    const longest = 'x'.repeat(MAX_TENANT_SUBDOMAIN_LENGTH)

    expect(bridgeInterfaceName(longest).length).toBeLessThanOrEqual(15)
  })

  test('refuses a subdomain that is not a valid one', () => {
    expect(() => bridgeInterfaceName('../etc')).toThrow(TypeError)
  })
})

describe('tenantNetworkOptions', () => {
  test('carries the bridge interface name under the Docker driver option key', () => {
    expect(tenantNetworkOptions('alice')).toEqual({ 'com.docker.network.bridge.name': bridgeInterfaceName('alice') })
  })
})

describe('isTenantLogin and adminNameOf', () => {
  test.each(['alice', 'Alice', 'a-b-c', 'A1', 'x'.repeat(39)])('accepts %s', (login) => {
    expect(isTenantLogin(login)).toBe(true)
  })

  test.each(['', '-alice', 'al ice', 'al_ice', 'x'.repeat(40), 'ali\nce'])('refuses %j', (login) => {
    expect(isTenantLogin(login)).toBe(false)
  })

  test('the admin name is the login lowercased', () => {
    expect(adminNameOf('Alice-Smith')).toBe('alice-smith')
  })
})

describe('tenantLabels', () => {
  test('carries the subdomain, and the login only when given', () => {
    expect(tenantLabels('alice')).toEqual({ [TENANT_LABEL]: 'alice' })
    expect(tenantLabels('alice', 'Alice')).toEqual({ [TENANT_LABEL]: 'alice', [LOGIN_LABEL]: 'Alice' })
  })
})

describe('containerSpec', () => {
  const spec = containerSpec(INPUT)

  test('runs the tenant image as node, labelled with the subdomain and the login', () => {
    expect(spec.Image).toBe('mcpcut-tenant:local')
    expect(spec.User).toBe('node')
    expect(spec.Labels).toEqual({ 'mcpcut.tenant': 'alice', 'mcpcut.login': 'Alice' })
    expect(spec.Cmd).toBeUndefined()
    expect(spec.Entrypoint).toBeUndefined()
  })

  test('the environment turns on tenant mode and names the public address', () => {
    expect(spec.Env).toEqual([
      'MCPCUT_TENANT=1',
      'MCPCUT_UI_PUBLIC_URL=https://alice.mcpcut.com',
      'MCPCUT_SERVE_PUBLIC_URL=https://alice.mcpcut.com',
      'MCPCUT_UI_HOST=0.0.0.0',
      'MCPCUT_SERVE_HOST=0.0.0.0',
      'TMPDIR=/tmp',
    ])
  })

  test('HostConfig carries every O3 limit and O4 network, and publishes no port', () => {
    expect(spec.HostConfig).toEqual({
      Memory: 256 * MIB,
      MemorySwap: 256 * MIB,
      NanoCpus: 250_000_000,
      PidsLimit: 128,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16m' },
      Mounts: [{ Type: 'volume', Source: 'mcpcut-t-alice', Target: TENANT_HOME_MOUNT }],
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: 'mcpcut-t-alice',
      Init: true,
      LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '3' } },
    })
    expect(TENANT_HOME_MOUNT).toBe('/home/node/.mcpcut')
    expect(spec).not.toHaveProperty('ExposedPorts')
    expect(JSON.stringify(spec)).not.toMatch(/PortBindings|Privileged|CapAdd|docker\.sock|Binds/)
  })

  test('the spec is frozen: a caller cannot widen it', () => {
    expect(Object.isFrozen(spec)).toBe(true)
    expect(Object.isFrozen(spec.HostConfig)).toBe(true)
  })

  test('refuses a bad subdomain, login, image or domain before anything is built', () => {
    expect(() => containerSpec({ ...INPUT, subdomain: 'www' })).toThrow(TypeError)
    expect(() => containerSpec({ ...INPUT, login: 'bad login' })).toThrow(TypeError)
    expect(() => containerSpec({ ...INPUT, image: 'evil image' })).toThrow(TypeError)
    expect(() => containerSpec({ ...INPUT, publicDomain: 'mcpcut.com/x' })).toThrow(TypeError)
  })

  test('the public URL is https on the subdomain', () => {
    expect(tenantPublicUrl('bob-2', 'example.org')).toBe('https://bob-2.example.org')
  })
})
