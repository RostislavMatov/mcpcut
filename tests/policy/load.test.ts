import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { DEFAULT_APPROVAL_TIMEOUT_MS, POLICY_ENV_VAR } from '../../src/policy/constants.js'
import { formatPolicyErrors, loadPolicy } from '../../src/policy/load.js'
import { policySchema } from '../../src/policy/schema.js'
import { resolvePolicySource } from '../../src/policy/source.js'

/** Minimal document that satisfies the schema: everything else has a default. */
const VALID_POLICY_JSON = JSON.stringify({ version: 1 })

let tempDir: string
let cwd: string
let journalDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcpcut-load-test-'))
  cwd = join(tempDir, 'project')
  journalDir = join(tempDir, 'home', '.mcpcut', 'data')
  await mkdir(cwd, { recursive: true })
  await mkdir(journalDir, { recursive: true })
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function projectPolicyPath(): string {
  return join(cwd, '.mcpcut-project', 'policy.json')
}

function homePolicyPath(): string {
  return join(journalDir, 'policy.json')
}

async function writeProjectPolicy(contents = VALID_POLICY_JSON): Promise<string> {
  const path = projectPolicyPath()
  await mkdir(join(cwd, '.mcpcut-project'), { recursive: true })
  await writeFile(path, contents, 'utf8')
  return path
}

async function writeHomePolicy(contents = VALID_POLICY_JSON): Promise<string> {
  const path = homePolicyPath()
  await writeFile(path, contents, 'utf8')
  return path
}

describe('loadPolicy: source precedence (first found wins, no merging)', () => {
  test('explicit path wins over env, project, and home', async () => {
    const explicitPath = join(tempDir, 'explicit-policy.json')
    const envPath = join(tempDir, 'env-policy.json')
    await writeFile(explicitPath, VALID_POLICY_JSON, 'utf8')
    await writeFile(envPath, VALID_POLICY_JSON, 'utf8')
    await writeProjectPolicy()
    await writeHomePolicy()

    const result = await loadPolicy({
      explicitPath,
      env: { [POLICY_ENV_VAR]: envPath },
      cwd,
      journalDir,
    })

    expect(result.status).toBe('loaded')
    if (result.status === 'loaded') {
      expect(result.sourcePath).toBe(explicitPath)
    }
  })

  test('env wins over project and home when no explicit path is given', async () => {
    const envPath = join(tempDir, 'env-policy.json')
    await writeFile(envPath, VALID_POLICY_JSON, 'utf8')
    await writeProjectPolicy()
    await writeHomePolicy()

    const result = await loadPolicy({ env: { [POLICY_ENV_VAR]: envPath }, cwd, journalDir })

    expect(result.status).toBe('loaded')
    if (result.status === 'loaded') {
      expect(result.sourcePath).toBe(envPath)
    }
  })

  test('project wins over home when no explicit path or env var is given', async () => {
    const projectPath = await writeProjectPolicy()
    await writeHomePolicy()

    const result = await loadPolicy({ env: {}, cwd, journalDir })

    expect(result.status).toBe('loaded')
    if (result.status === 'loaded') {
      expect(result.sourcePath).toBe(projectPath)
    }
  })

  test('home is used when nothing else is present', async () => {
    const homePath = await writeHomePolicy()

    const result = await loadPolicy({ env: {}, cwd, journalDir })

    expect(result.status).toBe('loaded')
    if (result.status === 'loaded') {
      expect(result.sourcePath).toBe(homePath)
    }
  })
})

describe('loadPolicy: missing files', () => {
  test('missing file at an explicitly requested path (flag) is an error', async () => {
    const explicitPath = join(tempDir, 'does-not-exist.json')

    const result = await loadPolicy({ explicitPath, env: {}, cwd, journalDir })

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.sourcePath).toBe(explicitPath)
      expect(result.errors.some((line) => line.includes(explicitPath))).toBe(true)
    }
  })

  test('missing file at an explicitly requested path (env) is an error', async () => {
    const envPath = join(tempDir, 'does-not-exist.json')

    const result = await loadPolicy({ env: { [POLICY_ENV_VAR]: envPath }, cwd, journalDir })

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.sourcePath).toBe(envPath)
    }
  })

  test('missing at every default location resolves to disabled', async () => {
    const result = await loadPolicy({ env: {}, cwd, journalDir })

    expect(result).toEqual({ status: 'disabled' })
  })
})

describe('loadPolicy: broken and invalid files', () => {
  test('broken JSON produces an error naming the source path', async () => {
    const path = await writeProjectPolicy('{not valid json')

    const result = await loadPolicy({ env: {}, cwd, journalDir })

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.sourcePath).toBe(path)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain(path)
    }
  })

  test('schema violation produces path-annotated errors', async () => {
    await writeProjectPolicy(JSON.stringify({ version: 1, tols: {} }))

    const result = await loadPolicy({ env: {}, cwd, journalDir })

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.errors).toContain('(root): unknown key "tols"')
    }
  })

  test('unreadable file (non-ENOENT fs error) is an error, not disabled', async () => {
    const expectedPath = projectPolicyPath()
    const readFile = async (path: string): Promise<string> => {
      if (path === expectedPath) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
    }

    const result = await loadPolicy({ env: {}, cwd, journalDir, readFile })

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.sourcePath).toBe(expectedPath)
      expect(result.errors[0]).toContain('permission denied')
    }
  })
})

describe('loadPolicy: env path hardening', () => {
  test('env value containing a null byte is an error, not a crash', async () => {
    const result = await loadPolicy({ env: { [POLICY_ENV_VAR]: 'bad\0path' }, cwd, journalDir })

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.errors[0]).toContain('null byte')
    }
  })

  test('empty env value is an error, not a silent fallback to cwd', async () => {
    const result = await loadPolicy({ env: { [POLICY_ENV_VAR]: '' }, cwd, journalDir })

    expect(result.status).toBe('error')
    if (result.status === 'error') {
      expect(result.errors[0]).toContain(POLICY_ENV_VAR)
    }
  })
})

describe('loadPolicy: defaults', () => {
  test('a minimal valid policy loads with schema defaults applied', async () => {
    await writeProjectPolicy()

    const result = await loadPolicy({ env: {}, cwd, journalDir })

    expect(result.status).toBe('loaded')
    if (result.status === 'loaded') {
      expect(result.policy.approval.timeoutMs).toBe(DEFAULT_APPROVAL_TIMEOUT_MS)
      expect(result.policy.defaultDecision).toBe('require-approval')
      expect(result.policy.quarantine.enabled).toBe(true)
    }
  })
})

describe('loadPolicy: default cwd/env', () => {
  test('resolves against process.env and process.cwd() when opts are omitted', async () => {
    const result = await loadPolicy()

    expect(['disabled', 'loaded', 'error']).toContain(result.status)
  })
})

/**
 * `policy/source.ts` advertises the resolution order to operators (`policy
 * show --entry-point`) from its own candidate table, while `loadPolicy` reads
 * from its own. These tests pin the two together: an advertised order that
 * drifts from the loaded one is exactly the "where did this allow come from?"
 * failure the single-source rule exists to prevent (ADR-0005).
 */
describe('advertised candidates match what loadPolicy actually reads', () => {
  test('operator entry: the first existing candidate is the file that loads, at every level', async () => {
    const explicitPath = join(tempDir, 'explicit-policy.json')
    const envPath = join(tempDir, 'env-policy.json')
    await writeFile(explicitPath, VALID_POLICY_JSON, 'utf8')
    await writeFile(envPath, VALID_POLICY_JSON, 'utf8')
    await writeProjectPolicy()
    await writeHomePolicy()

    const cases = [
      { args: { explicitPath, env: { [POLICY_ENV_VAR]: envPath } }, expected: explicitPath },
      { args: { env: { [POLICY_ENV_VAR]: envPath } }, expected: envPath },
      { args: { env: {} }, expected: projectPolicyPath() },
    ]

    for (const { args, expected } of cases) {
      const resolution = await resolvePolicySource({ entryPoint: 'serve', cwd, journalDir, ...args })
      expect(resolution.status).toBe('resolved')
      if (resolution.status !== 'resolved') return
      const result = await loadPolicy(resolution.loadOptions)

      expect(resolution.candidates[0]?.path).toBe(expected)
      expect(result.status === 'loaded' && result.sourcePath).toBe(expected)
    }
  })

  test('agent-launched entry: the loaded file is one of the advertised state-directory candidates', async () => {
    const homePath = await writeHomePolicy()
    await writeProjectPolicy()

    const resolution = await resolvePolicySource({
      entryPoint: 'connect',
      cwd,
      journalDir,
      env: { [POLICY_ENV_VAR]: homePath },
    })
    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    const result = await loadPolicy(resolution.loadOptions)

    expect(result.status === 'loaded' && result.sourcePath).toBe(homePath)
    expect(resolution.candidates.map((candidate) => candidate.path)).toContain(homePath)
  })
})

describe('formatPolicyErrors', () => {
  function issuesFor(value: unknown): string[] {
    const result = policySchema.safeParse(value)
    if (result.success) {
      throw new Error('expected schema validation to fail')
    }
    return formatPolicyErrors(result.error)
  }

  test('renders a root-level type error as "(root): message"', () => {
    const lines = issuesFor('not an object')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\(root\): /)
  })

  test('renders a nested field error with a dotted path', () => {
    const lines = issuesFor({ version: 1, approval: { timeoutMs: -1 } })
    expect(lines).toContainEqual(expect.stringMatching(/^approval\.timeoutMs: /))
  })

  test('expands unrecognized_keys into one line per key, at the container path', () => {
    const lines = issuesFor({
      version: 1,
      servers: { github: { tols: {} } },
    })
    expect(lines).toContain('servers.github: unknown key "tols"')
  })

  test('rejects an unsupported version with a path-annotated error', () => {
    const lines = issuesFor({ version: 2 })
    expect(lines.some((line) => line.startsWith('version:'))).toBe(true)
  })
})
