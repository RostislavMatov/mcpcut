import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { POLICY_ENV_VAR } from '../../src/policy/constants.js'
import { loadPolicy } from '../../src/policy/load.js'
import {
  ENTRY_POINTS,
  ENTRY_POINT_TRUST,
  isEntryPoint,
  resolvePolicySource,
  trustClassOf,
  type EntryPoint,
  type PolicySourceNotes,
} from '../../src/policy/source.js'

/**
 * The rule under test is ADR-0005: the policy source is decided by the entry
 * point's TRUST CLASS, not by the command name. `agent-launched` (`connect`)
 * reads the plane's state directory and nothing else; `operator-launched`
 * (`wrap`, `serve`, `ui`) keeps the four-source order of `policy/load.ts`.
 */

const VALID_POLICY_JSON = JSON.stringify({ version: 1 })

const OPERATOR_ENTRY_POINTS: readonly EntryPoint[] = ['wrap', 'serve', 'ui']

let tempDir: string
let cwd: string
let journalDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-source-test-'))
  cwd = join(tempDir, 'agent-project')
  journalDir = join(tempDir, 'home', '.mcp-journal')
  await mkdir(cwd, { recursive: true })
  await mkdir(journalDir, { recursive: true })
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

/** Captures the note lines a resolution writes, with a renderer of the caller's own wording. */
function captureNotes(): PolicySourceNotes & { lines: () => string[] } {
  const chunks: string[] = []
  return {
    write: (chunk: string) => chunks.push(chunk),
    render: (source: string, dir: string) => `ignoring ${source} (policy lives in ${dir})\n`,
    lines: () => chunks.join('').split('\n').filter((line) => line.length > 0),
  }
}

async function writeProjectPolicy(contents = VALID_POLICY_JSON): Promise<string> {
  const path = join(cwd, '.mcp-journal', 'policy.json')
  await mkdir(join(cwd, '.mcp-journal'), { recursive: true })
  await writeFile(path, contents, 'utf8')
  return path
}

async function writeStatePolicy(contents = VALID_POLICY_JSON): Promise<string> {
  const path = join(journalDir, 'policy.json')
  await writeFile(path, contents, 'utf8')
  return path
}

async function writeEnvPolicy(contents = VALID_POLICY_JSON): Promise<string> {
  const path = join(tempDir, 'env-policy.json')
  await writeFile(path, contents, 'utf8')
  return path
}

describe('entry point trust classes', () => {
  test('connect is agent-launched; wrap, serve and ui are operator-launched', () => {
    expect(trustClassOf('connect')).toBe('agent-launched')
    for (const entryPoint of OPERATOR_ENTRY_POINTS) {
      expect(trustClassOf(entryPoint)).toBe('operator-launched')
    }
  })

  test('the table is exhaustive: every known entry point has a trust class', () => {
    expect([...ENTRY_POINTS].sort()).toEqual(['connect', 'serve', 'ui', 'wrap'])
    for (const entryPoint of ENTRY_POINTS) {
      expect(ENTRY_POINT_TRUST[entryPoint]).toMatch(/^(agent|operator)-launched$/)
    }
  })

  test('isEntryPoint rejects an unknown name (CLI input is untrusted)', () => {
    expect(isEntryPoint('connect')).toBe(true)
    expect(isEntryPoint('Connect')).toBe(false)
    expect(isEntryPoint('daemon')).toBe(false)
    expect(isEntryPoint('')).toBe(false)
  })
})

describe('resolvePolicySource: connect (agent-launched)', () => {
  test('--policy is refused, not merely ignored', async () => {
    const resolution = await resolvePolicySource({
      entryPoint: 'connect',
      journalDir,
      env: {},
      cwd,
      explicitPath: join(tempDir, 'agent-chosen.json'),
    })

    expect(resolution.status).toBe('refused')
    if (resolution.status === 'refused') {
      expect(resolution.trustClass).toBe('agent-launched')
      expect(resolution.entryPoint).toBe('connect')
    }
  })

  test('a refusal is decided before any source is probed', async () => {
    const probed: string[] = []
    const readFile = async (path: string): Promise<string> => {
      probed.push(path)
      return VALID_POLICY_JSON
    }
    const notes = captureNotes()

    const resolution = await resolvePolicySource({
      entryPoint: 'connect',
      journalDir,
      env: { [POLICY_ENV_VAR]: '/tmp/whatever.json' },
      cwd,
      explicitPath: join(tempDir, 'agent-chosen.json'),
      readFile,
      notes,
    })

    expect(resolution.status).toBe('refused')
    expect(probed).toEqual([])
    expect(notes.lines()).toEqual([])
  })

  test('the load options neutralize every agent-controlled source', async () => {
    const resolution = await resolvePolicySource({
      entryPoint: 'connect',
      journalDir,
      env: { [POLICY_ENV_VAR]: '/tmp/env.json' },
      cwd,
    })

    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.trustClass).toBe('agent-launched')
    // Neutralized, not deprioritized: an empty env removes the override and a
    // cwd pointing at the state directory keeps the project candidate inside it.
    expect(resolution.loadOptions.env).toEqual({})
    expect(resolution.loadOptions.cwd).toBe(journalDir)
    expect(resolution.loadOptions.journalDir).toBe(journalDir)
    expect(resolution.loadOptions.explicitPath).toBeUndefined()
  })

  test('both candidates resolve inside the state directory, in order', async () => {
    const resolution = await resolvePolicySource({ entryPoint: 'connect', journalDir, env: {}, cwd })

    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.candidates.map((candidate) => candidate.path)).toEqual([
      join(journalDir, '.mcp-journal', 'policy.json'),
      join(journalDir, 'policy.json'),
    ])
    expect(resolution.candidates.every((candidate) => candidate.required)).toBe(false)
  })

  test('a set $MCP_JOURNAL_POLICY produces exactly one note line', async () => {
    const notes = captureNotes()

    const resolution = await resolvePolicySource({
      entryPoint: 'connect',
      journalDir,
      env: { [POLICY_ENV_VAR]: await writeEnvPolicy() },
      cwd,
      notes,
    })

    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.ignored).toEqual([{ kind: 'env', descriptor: `$${POLICY_ENV_VAR}` }])
    expect(notes.lines()).toHaveLength(1)
    expect(notes.lines()[0]).toContain(`$${POLICY_ENV_VAR}`)
  })

  test('an existing project policy produces exactly one note line naming its path', async () => {
    const projectPath = await writeProjectPolicy()
    const notes = captureNotes()

    const resolution = await resolvePolicySource({
      entryPoint: 'connect',
      journalDir,
      env: {},
      cwd,
      notes,
    })

    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.ignored).toEqual([{ kind: 'project', descriptor: projectPath }])
    expect(notes.lines()).toEqual([`ignoring ${projectPath} (policy lives in ${journalDir})\n`.trimEnd()])
  })

  test('both ignored sources present: one line each, never two for one source', async () => {
    await writeProjectPolicy()
    const notes = captureNotes()

    const resolution = await resolvePolicySource({
      entryPoint: 'connect',
      journalDir,
      env: { [POLICY_ENV_VAR]: await writeEnvPolicy() },
      cwd,
      notes,
    })

    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.ignored.map((source) => source.kind)).toEqual(['env', 'project'])
    expect(notes.lines()).toHaveLength(2)
  })

  test('a project policy that does not exist is not announced (no note on every run)', async () => {
    const notes = captureNotes()

    const resolution = await resolvePolicySource({
      entryPoint: 'connect',
      journalDir,
      env: {},
      cwd,
      notes,
    })

    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.ignored).toEqual([])
    expect(notes.lines()).toEqual([])
  })

  test('resolving without a notes sink is silent but still reports what was ignored', async () => {
    await writeProjectPolicy()

    const resolution = await resolvePolicySource({
      entryPoint: 'connect',
      journalDir,
      env: { [POLICY_ENV_VAR]: '/tmp/env.json' },
      cwd,
    })

    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.ignored).toHaveLength(2)
  })

  test('loading through the resolution really ignores env and project files', async () => {
    const statePath = await writeStatePolicy()
    await writeProjectPolicy(JSON.stringify({ version: 1, defaultDecision: 'deny' }))
    const envPath = await writeEnvPolicy(JSON.stringify({ version: 1, defaultDecision: 'deny' }))

    const resolution = await resolvePolicySource({
      entryPoint: 'connect',
      journalDir,
      env: { [POLICY_ENV_VAR]: envPath },
      cwd,
    })
    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    const result = await loadPolicy(resolution.loadOptions)

    expect(result.status).toBe('loaded')
    if (result.status !== 'loaded') return
    expect(result.sourcePath).toBe(statePath)
  })

  test('no policy in the state directory: nothing found, and no fallback to agent sources', async () => {
    await writeProjectPolicy()

    const resolution = await resolvePolicySource({ entryPoint: 'connect', journalDir, env: {}, cwd })
    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    const result = await loadPolicy(resolution.loadOptions)

    expect(result.status).toBe('disabled')
  })
})

describe('resolvePolicySource: operator-launched entry points keep the load.ts order', () => {
  test.each(OPERATOR_ENTRY_POINTS)('%s: --policy is honored, not refused', async (entryPoint) => {
    const explicitPath = join(tempDir, 'operator-chosen.json')
    await writeFile(explicitPath, VALID_POLICY_JSON, 'utf8')

    const resolution = await resolvePolicySource({ entryPoint, journalDir, env: {}, cwd, explicitPath })

    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.trustClass).toBe('operator-launched')
    expect(resolution.loadOptions.explicitPath).toBe(explicitPath)
    expect(resolution.candidates).toEqual([{ path: explicitPath, required: true }])
    const result = await loadPolicy(resolution.loadOptions)
    expect(result.status === 'loaded' && result.sourcePath).toBe(explicitPath)
  })

  test.each(OPERATOR_ENTRY_POINTS)('%s: $MCP_JOURNAL_POLICY is honored', async (entryPoint) => {
    const envPath = await writeEnvPolicy()
    await writeProjectPolicy()
    await writeStatePolicy()

    const resolution = await resolvePolicySource({
      entryPoint,
      journalDir,
      env: { [POLICY_ENV_VAR]: envPath },
      cwd,
    })

    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.ignored).toEqual([])
    expect(resolution.candidates).toEqual([{ path: envPath, required: true }])
    const result = await loadPolicy(resolution.loadOptions)
    expect(result.status === 'loaded' && result.sourcePath).toBe(envPath)
  })

  test.each(OPERATOR_ENTRY_POINTS)('%s: project beats state directory', async (entryPoint) => {
    const projectPath = await writeProjectPolicy()
    await writeStatePolicy()

    const resolution = await resolvePolicySource({ entryPoint, journalDir, env: {}, cwd })

    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.candidates).toEqual([
      { path: projectPath, required: false },
      { path: join(journalDir, 'policy.json'), required: false },
    ])
    const result = await loadPolicy(resolution.loadOptions)
    expect(result.status === 'loaded' && result.sourcePath).toBe(projectPath)
  })

  test.each(OPERATOR_ENTRY_POINTS)('%s: nothing is ever announced as ignored', async (entryPoint) => {
    await writeProjectPolicy()
    const notes = captureNotes()

    const resolution = await resolvePolicySource({
      entryPoint,
      journalDir,
      env: { [POLICY_ENV_VAR]: await writeEnvPolicy() },
      cwd,
      notes,
    })

    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.ignored).toEqual([])
    expect(notes.lines()).toEqual([])
  })

  test('an unreadable env value is still shown as the candidate it names', async () => {
    const resolution = await resolvePolicySource({
      entryPoint: 'serve',
      journalDir,
      env: { [POLICY_ENV_VAR]: '' },
      cwd,
    })

    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.candidates).toEqual([{ path: '', required: true }])
    const result = await loadPolicy(resolution.loadOptions)
    expect(result.status).toBe('error')
  })

  test('the injected readFile seam is threaded through to the load options', async () => {
    const readFile = async (): Promise<string> => VALID_POLICY_JSON

    const resolution = await resolvePolicySource({ entryPoint: 'ui', journalDir, env: {}, cwd, readFile })

    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.loadOptions.readFile).toBe(readFile)
  })
})

describe('resolvePolicySource: defaults', () => {
  test('an omitted cwd and env fall back to the process ones without throwing', async () => {
    const resolution = await resolvePolicySource({ entryPoint: 'serve', journalDir })

    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.loadOptions.cwd).toBe(process.cwd())
    expect(resolution.loadOptions.env).toBe(process.env)
  })

  test('an omitted journalDir falls back to the configured state directory', async () => {
    const resolution = await resolvePolicySource({ entryPoint: 'connect', env: {}, cwd })

    expect(resolution.status).toBe('resolved')
    if (resolution.status !== 'resolved') return
    expect(resolution.loadOptions.journalDir).toBeTypeOf('string')
    expect(resolution.loadOptions.cwd).toBe(resolution.loadOptions.journalDir)
  })
})
