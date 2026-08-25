import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createPolicyFileWriter,
  defaultPolicyFileDeps,
  POLICY_LOCK_STALE_MS,
  readPolicyFileForEdit,
  writePolicyFile,
  type PolicyFileDeps,
} from '../../../src/policy/edit/policy-file.js'
import { applyToolRuleToDocument } from '../../../src/policy/edit/set-tool-rule.js'
import { loadPolicy } from '../../../src/policy/load.js'
import { policyHashOf } from '../../../src/policy/provenance.js'
import { parsePolicy, type Policy } from '../../../src/policy/schema.js'

/**
 * `policy-file.ts` (policy-tool-rules-ui plan §2): the one write path for
 * `policy.json`. Read-for-edit distinguishes absent / loaded / broken;
 * write is compare-and-swap on `policyHashOf` (the CAS token the UI form
 * carries), atomic (tmp + rename in the same directory) and serialized
 * in-process per path. Parity gate of wave 1: what was written loads back
 * through `loadPolicy` with the same `policyHashOf`.
 */

const TEMP_SUFFIX = '.tmp'
const LOCK_SUFFIX = '.lock'
const ONE_SECOND_MS = 1000
const FILE_MODE_MASK = 0o777
const OWNER_ONLY_MODE = 0o600

let tempDir: string
let policyPath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'mcp-journal-policy-file-'))
  policyPath = join(tempDir, 'policy.json')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function policyOf(overrides: Record<string, unknown> = {}): Policy {
  const result = parsePolicy({ version: 1, ...overrides })
  if (!result.ok) throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

async function writeRaw(contents: string): Promise<void> {
  await writeFile(policyPath, contents, 'utf8')
}

async function tempFilesIn(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(TEMP_SUFFIX))
}

async function lockFilesIn(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.includes(LOCK_SUFFIX))
}

function lockPath(): string {
  return `${policyPath}${LOCK_SUFFIX}`
}

/** A lock left by another writer, `ageMs` old. */
async function plantLock(ageMs: number): Promise<void> {
  await writeFile(lockPath(), '', 'utf8')
  const atMs = Date.now() - ageMs
  await utimes(lockPath(), atMs / ONE_SECOND_MS, atMs / ONE_SECOND_MS)
}

async function loadedHash(path: string): Promise<string> {
  const loaded = await loadPolicy({ explicitPath: path })
  if (loaded.status !== 'loaded') throw new Error(`policy did not load: ${loaded.status}`)
  return policyHashOf(loaded.policy)
}

describe('readPolicyFileForEdit', () => {
  test('reports absent when there is no file', async () => {
    expect(await readPolicyFileForEdit(policyPath)).toEqual({ status: 'absent' })
  })

  test('loads a valid file with its effective hash, raw text and raw document', async () => {
    const raw = '{"version":1,"servers":{"github":{"tools":{"create_issue":"deny"}}}}\n'
    await writeRaw(raw)
    const result = await readPolicyFileForEdit(policyPath)
    expect(result.status).toBe('loaded')
    if (result.status !== 'loaded') return
    expect(result.raw).toBe(raw)
    expect(result.document).toEqual(JSON.parse(raw))
    // The document is the file as written; the policy is its effective form.
    expect(Object.keys(result.document as object)).toEqual(['version', 'servers'])
    expect(result.policy.approval.timeoutMs).toBeGreaterThan(0)
    expect(result.hash).toBe(await loadedHash(policyPath))
    expect(result.policy.servers?.['github']?.tools).toEqual({ create_issue: 'deny' })
  })

  test('reports invalid JSON as an error with the loader wording', async () => {
    await writeRaw('{"version": 1,')
    const result = await readPolicyFileForEdit(policyPath)
    expect(result.status).toBe('error')
    if (result.status === 'error') expect(result.errors[0]).toContain('invalid JSON')
  })

  test('reports a schema violation as an error with the field path', async () => {
    await writeRaw('{"version":1,"servers":{"github":{"tols":{}}}}')
    const result = await readPolicyFileForEdit(policyPath)
    expect(result.status).toBe('error')
    if (result.status === 'error') expect(result.errors.join('\n')).toContain('unknown key "tols"')
  })

  test('reports a read failure other than ENOENT as an error, not absent', async () => {
    const deps: PolicyFileDeps = {
      ...defaultPolicyFileDeps,
      readFile: async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      },
    }
    const result = await readPolicyFileForEdit(policyPath, deps)
    expect(result.status).toBe('error')
    if (result.status === 'error') expect(result.errors[0]).toContain('permission denied')
  })
})

describe('writePolicyFile: happy path and parity', () => {
  test('creates the file when expectedHash is null and none exists', async () => {
    const policy = policyOf({ servers: { github: { tools: { create_issue: 'deny' } } } })
    const result = await writePolicyFile(policyPath, policy, { expectedHash: null })
    expect(result).toEqual({ status: 'written', hashBefore: null, hashAfter: policyHashOf(policy) })
  })

  test('a written file loads back through loadPolicy with the same policyHashOf', async () => {
    const policy = policyOf({
      defaultDecision: 'deny',
      servers: { github: { tools: { create_issue: 'require-approval', 'delete_*': 'deny' } } },
    })
    const result = await writePolicyFile(policyPath, policy, { expectedHash: null })
    expect(result.status).toBe('written')
    expect(await loadedHash(policyPath)).toBe(policyHashOf(policy))
  })

  test('serializes the document with two-space indentation and a trailing newline', async () => {
    const document = { version: 1, servers: { github: { tools: { create_issue: 'deny' } } } }
    await writePolicyFile(policyPath, document, { expectedHash: null })
    const text = await readFile(policyPath, 'utf8')
    expect(text).toBe(`${JSON.stringify(document, null, 2)}\n`)
  })

  test('overwrites when expectedHash matches the file on disk and reports both hashes', async () => {
    await writeRaw('{"version":1}')
    const before = await readPolicyFileForEdit(policyPath)
    if (before.status !== 'loaded') throw new Error('fixture did not load')
    const edited = applyToolRuleToDocument(before.document, 'github', 'create_issue', 'deny')
    if (!edited.ok) throw new Error(edited.message)

    const result = await writePolicyFile(policyPath, edited.document, { expectedHash: before.hash })
    expect(result).toEqual({
      status: 'written',
      hashBefore: before.hash,
      hashAfter: policyHashOf(edited.policy),
    })
    expect(await loadedHash(policyPath)).toBe(policyHashOf(edited.policy))
  })

  test('the edit → write → read-for-edit loop round-trips the CAS token', async () => {
    await writeRaw('{"version":1}')
    const first = await readPolicyFileForEdit(policyPath)
    if (first.status !== 'loaded') throw new Error('fixture did not load')
    const edited = applyToolRuleToDocument(first.document, 'github', 'create_issue', 'deny')
    if (!edited.ok) throw new Error(edited.message)
    const written = await writePolicyFile(policyPath, edited.document, { expectedHash: first.hash })
    if (written.status !== 'written') throw new Error(`write failed: ${written.status}`)

    const second = await readPolicyFileForEdit(policyPath)
    expect(second.status).toBe('loaded')
    if (second.status === 'loaded') expect(second.hash).toBe(written.hashAfter)
  })

  test('the file is created owner-read/write only', async () => {
    await writePolicyFile(policyPath, policyOf(), { expectedHash: null })
    const info = await stat(policyPath)
    expect(info.mode & FILE_MODE_MASK).toBe(OWNER_ONLY_MODE)
  })
})

describe('writePolicyFile: the file stays the operator\'s', () => {
  async function editAndWrite(serverName: string, toolName: string, rule: 'allow' | 'deny' | null): Promise<string> {
    const before = await readPolicyFileForEdit(policyPath)
    if (before.status !== 'loaded') throw new Error(`fixture did not load: ${before.status}`)
    const edited = applyToolRuleToDocument(before.document, serverName, toolName, rule)
    if (!edited.ok) throw new Error(edited.message)
    const written = await writePolicyFile(policyPath, edited.document, { expectedHash: before.hash })
    if (written.status !== 'written') throw new Error(`write failed: ${written.status}`)
    return readFile(policyPath, 'utf8')
  }

  test('a minimal {"version":1} plus one rule is written with exactly version and servers.x.tools.y', async () => {
    await writeRaw('{"version":1}')
    const text = await editAndWrite('x', 'y', 'deny')
    expect(JSON.parse(text)).toEqual({ version: 1, servers: { x: { tools: { y: 'deny' } } } })
    expect(text).not.toContain('approval')
    expect(text).not.toContain('quarantine')
    expect(text).not.toContain('defaultDecision')
  })

  test('the written minimal file still loads with the same policyHashOf as the edited policy', async () => {
    await writeRaw('{"version":1}')
    await editAndWrite('x', 'y', 'deny')
    const edited = applyToolRuleToDocument({ version: 1 }, 'x', 'y', 'deny')
    if (!edited.ok) throw new Error(edited.message)
    expect(await loadedHash(policyPath)).toBe(policyHashOf(edited.policy))
  })

  test("an operator's explicit unrelated keys survive verbatim", async () => {
    await writeRaw(
      '{"version":1,"defaultDecision":"deny","approval":{"timeoutMs":1234},"servers":{"fs":{"defaultDecision":"allow"}}}',
    )
    const text = await editAndWrite('github', 'create_issue', 'allow')
    expect(JSON.parse(text)).toEqual({
      version: 1,
      defaultDecision: 'deny',
      approval: { timeoutMs: 1234 },
      servers: { fs: { defaultDecision: 'allow' }, github: { tools: { create_issue: 'allow' } } },
    })
    expect(Object.keys(JSON.parse(text) as object)).toEqual(['version', 'defaultDecision', 'approval', 'servers'])
  })

  test('removing the only rule leaves {"version":1} with no servers husk', async () => {
    await writeRaw('{"version":1,"servers":{"x":{"tools":{"y":"deny"}}}}')
    const text = await editAndWrite('x', 'y', null)
    expect(text).toBe('{\n  "version": 1\n}\n')
  })
})

describe('writePolicyFile: compare-and-swap', () => {
  test('conflicts when the hash on disk differs from expectedHash', async () => {
    await writeRaw('{"version":1,"defaultDecision":"deny"}')
    const onDisk = await loadedHash(policyPath)
    const result = await writePolicyFile(policyPath, policyOf(), { expectedHash: 'f'.repeat(64) })
    expect(result).toEqual({ status: 'conflict', currentHash: onDisk })
    // Nothing was written.
    expect(await loadedHash(policyPath)).toBe(onDisk)
  })

  test('conflicts when a file exists but the caller expected none (null)', async () => {
    await writeRaw('{"version":1}')
    const onDisk = await loadedHash(policyPath)
    const result = await writePolicyFile(policyPath, policyOf(), { expectedHash: null })
    expect(result).toEqual({ status: 'conflict', currentHash: onDisk })
  })

  test('conflicts when the caller expected a file but it is absent', async () => {
    const result = await writePolicyFile(policyPath, policyOf(), { expectedHash: 'f'.repeat(64) })
    expect(result).toEqual({ status: 'conflict', currentHash: null })
    expect(await readPolicyFileForEdit(policyPath)).toEqual({ status: 'absent' })
  })

  test('a formatting-only difference on disk is NOT a conflict (hash is of the effective policy)', async () => {
    await writeRaw('{\n  "version": 1,\n  "defaultDecision": "require-approval"\n}\n')
    const expected = policyHashOf(policyOf())
    const result = await writePolicyFile(policyPath, policyOf({ defaultDecision: 'deny' }), {
      expectedHash: expected,
    })
    expect(result.status).toBe('written')
  })

  test('refuses to write over a file that does not parse: error, not conflict, file untouched', async () => {
    const broken = '{"version": 1,'
    await writeRaw(broken)
    const result = await writePolicyFile(policyPath, policyOf(), { expectedHash: null })
    expect(result.status).toBe('error')
    expect(await readFile(policyPath, 'utf8')).toBe(broken)
  })

  test('two in-process writers racing on the same token: exactly one wins', async () => {
    await writeRaw('{"version":1}')
    const before = await readPolicyFileForEdit(policyPath)
    if (before.status !== 'loaded') throw new Error('fixture did not load')
    const first = applyToolRuleToDocument(before.document, 'github', 'a', 'deny')
    const second = applyToolRuleToDocument(before.document, 'github', 'b', 'allow')
    if (!first.ok || !second.ok) throw new Error('fixture edits failed')

    const results = await Promise.all([
      writePolicyFile(policyPath, first.document, { expectedHash: before.hash }),
      writePolicyFile(policyPath, second.document, { expectedHash: before.hash }),
    ])
    const statuses = results.map((result) => result.status).sort()
    expect(statuses).toEqual(['conflict', 'written'])
    // The loser saw the winner's hash, not a stale one.
    const winner = results.find((result) => result.status === 'written')
    const loser = results.find((result) => result.status === 'conflict')
    if (winner?.status === 'written' && loser?.status === 'conflict') {
      expect(loser.currentHash).toBe(winner.hashAfter)
    }
  })
})

describe('writePolicyFile: atomicity', () => {
  test('leaves no temp file behind after a successful write', async () => {
    await writePolicyFile(policyPath, policyOf(), { expectedHash: null })
    expect(await tempFilesIn(tempDir)).toEqual([])
    expect(await readdir(tempDir)).toEqual(['policy.json'])
  })

  test('the temp file is created in the same directory as the target', async () => {
    const seen: string[] = []
    const deps: PolicyFileDeps = {
      ...defaultPolicyFileDeps,
      writeFile: async (path, content) => {
        seen.push(path)
        await defaultPolicyFileDeps.writeFile(path, content)
      },
    }
    await writePolicyFile(policyPath, policyOf(), { expectedHash: null }, deps)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.startsWith(`${tempDir}/`)).toBe(true)
    expect(seen[0]).not.toBe(policyPath)
  })

  test('a failed rename leaves the original intact and removes the temp file', async () => {
    const original = '{"version":1,"defaultDecision":"deny"}'
    await writeRaw(original)
    const onDisk = await loadedHash(policyPath)
    const deps: PolicyFileDeps = {
      ...defaultPolicyFileDeps,
      rename: async () => {
        throw new Error('disk on fire')
      },
    }
    const result = await writePolicyFile(policyPath, policyOf(), { expectedHash: onDisk }, deps)
    expect(result.status).toBe('error')
    if (result.status === 'error') expect(result.errors[0]).toContain('disk on fire')
    expect(await readFile(policyPath, 'utf8')).toBe(original)
    expect(await tempFilesIn(tempDir)).toEqual([])
  })

  test('a failed temp write reports an error and leaves nothing behind', async () => {
    const deps: PolicyFileDeps = {
      ...defaultPolicyFileDeps,
      writeFile: async () => {
        throw Object.assign(new Error('no space left'), { code: 'ENOSPC' })
      },
    }
    const result = await writePolicyFile(policyPath, policyOf(), { expectedHash: null }, deps)
    expect(result.status).toBe('error')
    expect(await readdir(tempDir)).toEqual([])
  })
})

describe('writePolicyFile: cross-process lock', () => {
  test('two independent writers (two processes) racing on the same token: exactly one wins', async () => {
    await writeRaw('{"version":1}')
    const before = await readPolicyFileForEdit(policyPath)
    if (before.status !== 'loaded') throw new Error('fixture did not load')
    const first = applyToolRuleToDocument(before.document, 'github', 'a', 'deny')
    const second = applyToolRuleToDocument(before.document, 'github', 'b', 'allow')
    if (!first.ok || !second.ok) throw new Error('fixture edits failed')

    // Separate writers = separate in-process chains: only the lock file on
    // disk stands between them, exactly as between `ui` and `policy set`.
    const processA = createPolicyFileWriter()
    const processB = createPolicyFileWriter()
    const results = await Promise.all([
      processA.write(policyPath, first.document, { expectedHash: before.hash }),
      processB.write(policyPath, second.document, { expectedHash: before.hash }),
    ])
    expect(results.map((result) => result.status).sort()).toEqual(['conflict', 'written'])
    expect(await lockFilesIn(tempDir)).toEqual([])
    expect(await tempFilesIn(tempDir)).toEqual([])
  })

  test('the in-process chain alone would not have stopped them: the lock is what did', async () => {
    await writeRaw('{"version":1}')
    const before = await readPolicyFileForEdit(policyPath)
    if (before.status !== 'loaded') throw new Error('fixture did not load')
    const seen: string[] = []
    const deps: PolicyFileDeps = {
      ...defaultPolicyFileDeps,
      openExclusive: async (path) => {
        seen.push(path)
        await defaultPolicyFileDeps.openExclusive(path)
      },
    }
    const results = await Promise.all([
      createPolicyFileWriter().write(policyPath, before.document, { expectedHash: before.hash }, deps),
      createPolicyFileWriter().write(policyPath, before.document, { expectedHash: before.hash }, deps),
    ])
    expect(results.map((result) => result.status).sort()).toEqual(['conflict', 'written'])
    // Both writers reached for the same lock; the second create failed.
    expect(seen).toEqual([lockPath(), lockPath()])
  })

  test('a fresh foreign lock yields conflict with the current on-disk hash, without waiting', async () => {
    await writeRaw('{"version":1,"defaultDecision":"deny"}')
    const onDisk = await loadedHash(policyPath)
    await plantLock(0)
    const startedAt = Date.now()
    const result = await writePolicyFile(policyPath, policyOf(), { expectedHash: onDisk })
    expect(result).toEqual({ status: 'conflict', currentHash: onDisk })
    expect(Date.now() - startedAt).toBeLessThan(POLICY_LOCK_STALE_MS)
    // A foreign lock is never removed by the writer that lost to it.
    expect(await lockFilesIn(tempDir)).toEqual(['policy.json.lock'])
    expect(await loadedHash(policyPath)).toBe(onDisk)
  })

  test('a fresh foreign lock on an absent file yields conflict with currentHash null', async () => {
    await plantLock(0)
    const result = await writePolicyFile(policyPath, policyOf(), { expectedHash: null })
    expect(result).toEqual({ status: 'conflict', currentHash: null })
  })

  test('a stale lock (older than POLICY_LOCK_STALE_MS) is broken and the write proceeds', async () => {
    await writeRaw('{"version":1}')
    const onDisk = await loadedHash(policyPath)
    await plantLock(POLICY_LOCK_STALE_MS + ONE_SECOND_MS)
    const result = await writePolicyFile(policyPath, policyOf({ defaultDecision: 'deny' }), {
      expectedHash: onDisk,
    })
    expect(result.status).toBe('written')
    expect(await lockFilesIn(tempDir)).toEqual([])
    expect(await readdir(tempDir)).toEqual(['policy.json'])
  })

  test('the lock never survives a CAS conflict', async () => {
    await writeRaw('{"version":1}')
    const result = await writePolicyFile(policyPath, policyOf(), { expectedHash: 'f'.repeat(64) })
    expect(result.status).toBe('conflict')
    expect(await lockFilesIn(tempDir)).toEqual([])
  })

  test('the lock never survives a failed rename', async () => {
    await writeRaw('{"version":1}')
    const onDisk = await loadedHash(policyPath)
    const deps: PolicyFileDeps = {
      ...defaultPolicyFileDeps,
      rename: async () => {
        throw new Error('disk on fire')
      },
    }
    const result = await writePolicyFile(policyPath, policyOf(), { expectedHash: onDisk }, deps)
    expect(result.status).toBe('error')
    expect(await readdir(tempDir)).toEqual(['policy.json'])
  })

  test('a lock the filesystem refuses for any reason but EEXIST is an error, not a conflict', async () => {
    await writeRaw('{"version":1}')
    const onDisk = await loadedHash(policyPath)
    const deps: PolicyFileDeps = {
      ...defaultPolicyFileDeps,
      openExclusive: async () => {
        throw Object.assign(new Error('read-only file system'), { code: 'EROFS' })
      },
    }
    const result = await writePolicyFile(policyPath, policyOf(), { expectedHash: onDisk }, deps)
    expect(result.status).toBe('error')
    if (result.status === 'error') expect(result.errors[0]).toContain('read-only file system')
    expect(await readFile(policyPath, 'utf8')).toBe('{"version":1}')
  })
})
