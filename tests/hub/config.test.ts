import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { loadHubConfig, type HubConfigLoad } from '../../hub/src/config.js'

/**
 * `hub/src/config.ts` (plan `hub-signin-accounts`, Task 2): env vars only,
 * the GitHub client secret read from a 0600 file, never accepted in the
 * environment. Every fixture below sets a complete, valid environment and
 * mutates exactly the field under test, so a failure always points at one
 * cause.
 */

let dir: string
let secretPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcpcut-hub-config-test-'))
  secretPath = join(dir, 'github-client-secret')
  await writeFile(secretPath, 'shhh-secret\n')
  await chmod(secretPath, 0o600)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    HUB_PUBLIC_URL: 'https://mcpcut.com',
    HUB_GITHUB_CLIENT_ID: 'Iv1.abc123',
    HUB_GITHUB_CLIENT_SECRET_FILE: secretPath,
    HUB_DATA_DIR: join(dir, 'data'),
    ...overrides,
  }
}

function expectInvalid(load: HubConfigLoad): readonly string[] {
  if (load.kind !== 'invalid') throw new Error('expected an invalid config')
  return load.problems
}

describe('loadHubConfig: happy path and defaults', () => {
  test('a minimal valid environment loads, with every default filled in', () => {
    const load = loadHubConfig({ env: validEnv() })
    expect(load.kind).toBe('ok')
    if (load.kind !== 'ok') return
    expect(load.config).toEqual({
      publicUrl: 'https://mcpcut.com',
      tenantDomain: 'mcpcut.com',
      githubClientId: 'Iv1.abc123',
      githubClientSecret: 'shhh-secret',
      dataDir: join(dir, 'data'),
      host: '127.0.0.1',
      port: 8092,
      maxAccounts: 15,
      minAccountAgeDays: 30,
      signupsPerHourPerIp: 3,
      trustCfConnectingIp: false,
    })
  })

  test('every knob can be overridden', () => {
    const load = loadHubConfig({
      env: validEnv({
        HUB_TENANT_DOMAIN: 'staging.example.com',
        HUB_HOST: '0.0.0.0',
        HUB_PORT: '9000',
        HUB_MAX_ACCOUNTS: '5',
        HUB_MIN_ACCOUNT_AGE_DAYS: '7',
        HUB_SIGNUPS_PER_HOUR_PER_IP: '1',
        HUB_TRUST_CF_CONNECTING_IP: '1',
      }),
    })
    expect(load.kind).toBe('ok')
    if (load.kind !== 'ok') return
    expect(load.config.tenantDomain).toBe('staging.example.com')
    expect(load.config.host).toBe('0.0.0.0')
    expect(load.config.port).toBe(9000)
    expect(load.config.maxAccounts).toBe(5)
    expect(load.config.minAccountAgeDays).toBe(7)
    expect(load.config.signupsPerHourPerIp).toBe(1)
    expect(load.config.trustCfConnectingIp).toBe(true)
  })

  test('the secret is trimmed of surrounding whitespace/newline', () => {
    const load = loadHubConfig({ env: validEnv() })
    if (load.kind !== 'ok') throw new Error('expected ok')
    expect(load.config.githubClientSecret).toBe('shhh-secret')
    expect(load.config.githubClientSecret).not.toMatch(/\n/)
  })
})

describe('loadHubConfig: required fields', () => {
  test('HUB_PUBLIC_URL is required', () => {
    const problems = expectInvalid(loadHubConfig({ env: validEnv({ HUB_PUBLIC_URL: undefined }) }))
    expect(problems).toEqual(['HUB_PUBLIC_URL: is required'])
  })

  test('HUB_PUBLIC_URL must be an https origin, not http', () => {
    const problems = expectInvalid(
      loadHubConfig({ env: validEnv({ HUB_PUBLIC_URL: 'http://mcpcut.com' }) }),
    )
    expect(problems).toEqual(['HUB_PUBLIC_URL: must be an https origin: https://host[:port], no path'])
  })

  test('HUB_PUBLIC_URL rejects a path', () => {
    const problems = expectInvalid(
      loadHubConfig({ env: validEnv({ HUB_PUBLIC_URL: 'https://mcpcut.com/signin' }) }),
    )
    expect(problems).toEqual(['HUB_PUBLIC_URL: must be an https origin: https://host[:port], no path'])
  })

  test('HUB_GITHUB_CLIENT_ID is required', () => {
    const problems = expectInvalid(
      loadHubConfig({ env: validEnv({ HUB_GITHUB_CLIENT_ID: undefined }) }),
    )
    expect(problems).toEqual(['HUB_GITHUB_CLIENT_ID: is required'])
  })

  test('HUB_DATA_DIR is required', () => {
    const problems = expectInvalid(loadHubConfig({ env: validEnv({ HUB_DATA_DIR: undefined }) }))
    expect(problems).toEqual(['HUB_DATA_DIR: is required'])
  })

  test('HUB_TENANT_DOMAIN rejects a bare label (no dot)', () => {
    const problems = expectInvalid(loadHubConfig({ env: validEnv({ HUB_TENANT_DOMAIN: 'localhost' }) }))
    expect(problems).toEqual(['HUB_TENANT_DOMAIN: must be a domain name, e.g. mcpcut.com'])
  })

  test('every problem is reported together, one per line', () => {
    const problems = expectInvalid(
      loadHubConfig({
        env: validEnv({ HUB_PUBLIC_URL: undefined, HUB_GITHUB_CLIENT_ID: undefined }),
      }),
    )
    expect(problems).toEqual(
      expect.arrayContaining(['HUB_PUBLIC_URL: is required', 'HUB_GITHUB_CLIENT_ID: is required']),
    )
    expect(problems).toHaveLength(2)
  })
})

describe('loadHubConfig: numeric and boolean fields', () => {
  test('a non-numeric HUB_PORT is refused, not silently defaulted', () => {
    const problems = expectInvalid(loadHubConfig({ env: validEnv({ HUB_PORT: 'not-a-number' }) }))
    expect(problems).toEqual(['HUB_PORT: must be an integer between 0 and 65535'])
  })

  test('HUB_MAX_ACCOUNTS out of range is refused', () => {
    const problems = expectInvalid(loadHubConfig({ env: validEnv({ HUB_MAX_ACCOUNTS: '0' }) }))
    expect(problems).toEqual(['HUB_MAX_ACCOUNTS: must be an integer between 1 and 1000'])
  })

  test('HUB_TRUST_CF_CONNECTING_IP rejects anything but "0"/"1"', () => {
    const problems = expectInvalid(
      loadHubConfig({ env: validEnv({ HUB_TRUST_CF_CONNECTING_IP: 'true' }) }),
    )
    expect(problems).toEqual(['HUB_TRUST_CF_CONNECTING_IP: must be "0" or "1"'])
  })
})

describe('loadHubConfig: the GitHub client secret file (H4)', () => {
  test('a missing secret file is refused', () => {
    const problems = expectInvalid(
      loadHubConfig({ env: validEnv({ HUB_GITHUB_CLIENT_SECRET_FILE: join(dir, 'nope') }) }),
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^HUB_GITHUB_CLIENT_SECRET_FILE: could not stat/)
  })

  test('a directory in place of the secret file is refused', async () => {
    const asDir = join(dir, 'a-directory')
    await mkdir(asDir)
    const problems = expectInvalid(
      loadHubConfig({ env: validEnv({ HUB_GITHUB_CLIENT_SECRET_FILE: asDir }) }),
    )
    expect(problems).toEqual([`HUB_GITHUB_CLIENT_SECRET_FILE: "${asDir}" is not a regular file`])
  })

  test('a group-readable secret file (0640) is refused as wider than 0600', async () => {
    await chmod(secretPath, 0o640)
    const problems = expectInvalid(loadHubConfig({ env: validEnv() }))
    expect(problems).toEqual([
      `HUB_GITHUB_CLIENT_SECRET_FILE: "${secretPath}" has mode 0640, wider than the required 0600 ` +
        '(owner read/write only)',
    ])
  })

  test('a world-readable secret file (0644) is refused', async () => {
    await chmod(secretPath, 0o644)
    const problems = expectInvalid(loadHubConfig({ env: validEnv() }))
    expect(problems[0]).toMatch(/wider than the required 0600/)
  })

  test('an owner-execute bit (0700) is also "wider than 0600" and refused', async () => {
    await chmod(secretPath, 0o700)
    const problems = expectInvalid(loadHubConfig({ env: validEnv() }))
    expect(problems[0]).toMatch(/wider than the required 0600/)
  })

  test('an owner-read-only file (0400) is allowed: a subset of 0600, not wider', async () => {
    await chmod(secretPath, 0o400)
    const load = loadHubConfig({ env: validEnv() })
    expect(load.kind).toBe('ok')
  })

  test('an empty secret file is refused', async () => {
    await writeFile(secretPath, '')
    await chmod(secretPath, 0o600)
    const problems = expectInvalid(loadHubConfig({ env: validEnv() }))
    expect(problems).toEqual([`HUB_GITHUB_CLIENT_SECRET_FILE: "${secretPath}" is empty`])
  })

  test('a secret consisting only of whitespace is refused', async () => {
    await writeFile(secretPath, '   \n')
    await chmod(secretPath, 0o600)
    const problems = expectInvalid(loadHubConfig({ env: validEnv() }))
    expect(problems).toEqual([`HUB_GITHUB_CLIENT_SECRET_FILE: "${secretPath}" is empty`])
  })

  test('the secret is never accepted as an env var directly', () => {
    // There is no schema key for a plaintext secret at all: passing one under
    // any plausible name must have no effect on the loaded config.
    const load = loadHubConfig({
      env: validEnv({ HUB_GITHUB_CLIENT_SECRET: 'from-the-environment' } as Record<string, string>),
    })
    expect(load.kind).toBe('ok')
    if (load.kind !== 'ok') return
    expect(load.config.githubClientSecret).toBe('shhh-secret')
  })

  test('a stat fault other than ENOENT is reported through the injected seam', () => {
    const problems = expectInvalid(
      loadHubConfig({
        env: validEnv(),
        statSecretFile: () => {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
        },
      }),
    )
    expect(problems).toEqual([
      `HUB_GITHUB_CLIENT_SECRET_FILE: could not stat "${secretPath}": EACCES: permission denied`,
    ])
  })

  test('a read fault surfaces as a problem, not an exception', () => {
    const problems = expectInvalid(
      loadHubConfig({
        env: validEnv(),
        readSecretFile: () => {
          throw new Error('boom')
        },
      }),
    )
    expect(problems).toEqual([`HUB_GITHUB_CLIENT_SECRET_FILE: could not read "${secretPath}": boom`])
  })
})
