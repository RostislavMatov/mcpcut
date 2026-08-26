import { describe, expect, test } from 'vitest'
import { POLICY_RECHECK_MIN_MS } from '../../src/policy/constants.js'
import type { LoadPolicyOptions } from '../../src/policy/load.js'
import { policyHashOf } from '../../src/policy/provenance.js'
import {
  createPolicyProvider,
  isPolicyProvider,
  mapPolicyProvider,
  staticPolicyProvider,
  STATIC_POLICY_SOURCE,
  toPolicyProvider,
  type PolicyFileVersion,
  type PolicyProvider,
  type PolicyReloadEvent,
  type PolicyReloadFailure,
  type PolicyShadowedEvent,
} from '../../src/policy/reload.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'

/**
 * The hot-reload policy provider (policy-tool-rules-ui plan, wave 2). What is
 * pinned here is the CONTRACT the gate relies on, not the file system:
 * `current()` is synchronous and never observes a half-applied swap, a check
 * runs at most once per `POLICY_RECHECK_MIN_MS`, a broken/vanished file keeps
 * the last valid policy and is reported once per file version (owner
 * decision O3), and every swap is announced with both hashes.
 */

const SOURCE_PATH = '/plane/policy.json'

const ALLOW_ALL = { version: 1, defaultDecision: 'allow', quarantine: { enabled: false } }
const DENY_ALL = { version: 1, defaultDecision: 'deny', quarantine: { enabled: false } }

function policyOf(document: Record<string, unknown>): Policy {
  const result = parsePolicy(document)
  if (!result.ok) throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

/** A fake file: its text, and the version `stat` reports for it. `null` = vanished. */
interface FakeFile {
  text: string | null
  version: PolicyFileVersion
}

interface Stand {
  readonly provider: PolicyProvider
  readonly file: FakeFile
  /** Paths that resolve BEFORE the bound file and currently exist (finding 2). */
  readonly shadowing: Set<string>
  readonly clock: { now: number }
  readonly reloads: PolicyReloadEvent[]
  readonly failures: PolicyReloadFailure[]
  readonly shadowed: PolicyShadowedEvent[]
  readonly statCalls: () => number
  readonly readCalls: () => number
}

function enoent(): Error {
  return Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
}

interface StandOptions {
  readonly initialDocument?: Record<string, unknown>
  readonly precedingCandidates?: readonly string[]
}

function createStand(opts: StandOptions = {}): Stand {
  const initialDocument = opts.initialDocument ?? ALLOW_ALL
  const file: FakeFile = { text: JSON.stringify(initialDocument), version: { mtimeMs: 1000, size: 10 } }
  const shadowing = new Set<string>()
  const clock = { now: 100_000 }
  const reloads: PolicyReloadEvent[] = []
  const failures: PolicyReloadFailure[] = []
  const shadowed: PolicyShadowedEvent[] = []
  let statCalls = 0
  let readCalls = 0

  const loadOptions: LoadPolicyOptions = {
    explicitPath: SOURCE_PATH,
    cwd: '/plane',
    env: {},
    journalDir: '/plane',
    readFile: (path) => {
      readCalls += 1
      if (path !== SOURCE_PATH || file.text === null) return Promise.reject(enoent())
      return Promise.resolve(file.text)
    },
  }
  /** One version source for both the sync (hot path) and async (`refresh()`) seams. */
  const statSync = (path: string): PolicyFileVersion => {
    if (path !== SOURCE_PATH) {
      if (shadowing.has(path)) return { mtimeMs: 1, size: 1 }
      throw enoent()
    }
    statCalls += 1
    if (file.text === null) throw enoent()
    return file.version
  }
  const provider = createPolicyProvider({
    initial: policyOf(initialDocument),
    sourcePath: SOURCE_PATH,
    loadOptions,
    ...(opts.precedingCandidates !== undefined ? { precedingCandidates: opts.precedingCandidates } : {}),
    now: () => clock.now,
    stat: (path) => {
      try {
        return Promise.resolve(statSync(path))
      } catch (error: unknown) {
        return Promise.reject(error)
      }
    },
    statSync,
    readFileSync: (path) => {
      readCalls += 1
      if (path !== SOURCE_PATH || file.text === null) throw enoent()
      return file.text
    },
    onReload: (event) => reloads.push(event),
    onError: (failure) => failures.push(failure),
    onShadowed: (event) => shadowed.push(event),
  })
  return {
    provider,
    file,
    shadowing,
    clock,
    reloads,
    failures,
    shadowed,
    statCalls: () => statCalls,
    readCalls: () => readCalls,
  }
}

/**
 * Lets a check scheduled by `maybeRefresh()` run to completion WITHOUT asking
 * for another one (`refresh()` deliberately queues a fresh check behind an
 * in-flight one). Every fake here settles in microtasks, so one macrotask is enough.
 */
function settleScheduledCheck(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Edits the fake file the way a hand edit lands on disk: new bytes, new mtime, new size. */
function editFile(stand: Stand, document: Record<string, unknown> | string): void {
  const text = typeof document === 'string' ? document : JSON.stringify(document)
  stand.file.text = text
  stand.file.version = { mtimeMs: stand.file.version.mtimeMs + 1, size: text.length }
}

/**
 * Edits the fake file WITHOUT moving its version: what a coarse-mtime file
 * system (or overlayfs) shows for two same-size writes inside one tick.
 */
function editFileSameVersion(stand: Stand, text: string): void {
  stand.file.text = text
}

describe('createPolicyProvider — the contract the gate relies on', () => {
  test('current() is the initial policy before any check ran, and never touches the file', () => {
    const stand = createStand()
    expect(stand.provider.current()).toEqual(policyOf(ALLOW_ALL))
    expect(stand.provider.sourcePath).toBe(SOURCE_PATH)
    expect(stand.statCalls()).toBe(0)
    expect(stand.readCalls()).toBe(0)
  })

  test('a hand edit is picked up on refresh: new rules, onReload with both hashes', async () => {
    const stand = createStand()
    editFile(stand, DENY_ALL)

    await stand.provider.refresh()

    expect(stand.provider.current().defaultDecision).toBe('deny')
    expect(stand.reloads).toEqual([
      {
        sourcePath: SOURCE_PATH,
        hashBefore: policyHashOf(policyOf(ALLOW_ALL)),
        hashAfter: policyHashOf(policyOf(DENY_ALL)),
      },
    ])
    expect(stand.failures).toEqual([])
  })

  test('an unchanged version is not re-read: one stat, zero reads after the baseline', async () => {
    const stand = createStand()
    await stand.provider.refresh()
    const readsAfterBaseline = stand.readCalls()

    await stand.provider.refresh()
    await stand.provider.refresh()

    expect(stand.statCalls()).toBe(3)
    expect(stand.readCalls()).toBe(readsAfterBaseline)
    expect(stand.reloads).toEqual([])
  })

  test('a formatting-only edit (same effective policy) swaps nothing and announces nothing', async () => {
    const stand = createStand()
    const before = stand.provider.current()
    editFile(stand, JSON.stringify(ALLOW_ALL, null, 2))

    await stand.provider.refresh()

    expect(stand.provider.current()).toBe(before)
    expect(stand.reloads).toEqual([])
    expect(stand.failures).toEqual([])
  })

  test('maybeRefresh() checks at most once per POLICY_RECHECK_MIN_MS', async () => {
    const stand = createStand()

    stand.provider.maybeRefresh()
    stand.provider.maybeRefresh()
    stand.clock.now += POLICY_RECHECK_MIN_MS - 1
    stand.provider.maybeRefresh()
    await settleScheduledCheck()
    expect(stand.statCalls()).toBe(1)

    stand.clock.now += 1
    stand.provider.maybeRefresh()
    await settleScheduledCheck()
    expect(stand.statCalls()).toBe(2)
  })

  test('maybeRefresh() swaps SYNCHRONOUSLY: the very next current() is the edited policy', () => {
    const stand = createStand()
    editFile(stand, DENY_ALL)

    stand.provider.maybeRefresh()

    expect(stand.provider.current().defaultDecision).toBe('deny')
    expect(stand.reloads).toHaveLength(1)
    expect(stand.readCalls()).toBe(1)
  })

  test('the sync hot path reads only on a version change: stat every check, read once per edit', () => {
    const stand = createStand()
    stand.provider.maybeRefresh()
    const readsAfterBaseline = stand.readCalls()

    stand.clock.now += POLICY_RECHECK_MIN_MS
    stand.provider.maybeRefresh()
    stand.clock.now += POLICY_RECHECK_MIN_MS
    stand.provider.maybeRefresh()

    expect(stand.statCalls()).toBe(3)
    expect(stand.readCalls()).toBe(readsAfterBaseline)
  })

  test('a broken edit on the sync path keeps the policy and reports once; the fix lands on the next check', () => {
    const stand = createStand()
    editFile(stand, '{ not json')
    stand.provider.maybeRefresh()
    stand.clock.now += POLICY_RECHECK_MIN_MS
    stand.provider.maybeRefresh()

    expect(stand.provider.current().defaultDecision).toBe('allow')
    expect(stand.failures).toHaveLength(1)

    editFile(stand, DENY_ALL)
    stand.clock.now += POLICY_RECHECK_MIN_MS
    stand.provider.maybeRefresh()
    expect(stand.provider.current().defaultDecision).toBe('deny')
  })

  test('a stale async read can never swap back over a newer sync swap', async () => {
    const stand = createStand()
    // An explicit async check is in flight and has already read the OLD text...
    const pending = stand.provider.refresh()
    // ...when an edit lands and the hot path swaps synchronously.
    editFile(stand, DENY_ALL)
    stand.clock.now += POLICY_RECHECK_MIN_MS
    stand.provider.maybeRefresh()
    expect(stand.provider.current().defaultDecision).toBe('deny')

    await pending
    expect(stand.provider.current().defaultDecision).toBe('deny')
  })

  test('a preceding candidate is noticed on the sync path too', () => {
    const stand = createStand({ precedingCandidates: ['/plane/.mcp-journal/policy.json'] })
    stand.shadowing.add('/plane/.mcp-journal/policy.json')
    stand.provider.maybeRefresh()
    expect(stand.shadowed).toHaveLength(1)
  })

  test('concurrent refresh() calls share at most one follow-up behind the in-flight check', async () => {
    const stand = createStand()
    editFile(stand, DENY_ALL)

    await Promise.all([stand.provider.refresh(), stand.provider.refresh(), stand.provider.refresh()])

    // One check in flight, one queued behind it for the callers that arrived
    // while it ran; the third caller shares the queued one.
    expect(stand.statCalls()).toBe(2)
    expect(stand.reloads).toHaveLength(1)
  })

  test('refresh() after an edit observes it even when a check was already in flight', async () => {
    const stand = createStand()
    // The gate's own scheduled check is mid-flight (it has already stat-ed the old version)...
    stand.provider.maybeRefresh()
    // ...when the edit lands and someone asks for a refresh.
    editFile(stand, DENY_ALL)

    await stand.provider.refresh()

    expect(stand.provider.current().defaultDecision).toBe('deny')
    expect(stand.reloads).toHaveLength(1)
  })
})

describe('createPolicyProvider — failure keeps the last valid policy (O3)', () => {
  test('invalid JSON: policy unchanged, one onError naming the file and the kept hash', async () => {
    const stand = createStand()
    editFile(stand, '{ not json')

    await stand.provider.refresh()

    expect(stand.provider.current()).toEqual(policyOf(ALLOW_ALL))
    expect(stand.reloads).toEqual([])
    expect(stand.failures).toHaveLength(1)
    const failure = stand.failures[0]!
    expect(failure.sourcePath).toBe(SOURCE_PATH)
    expect(failure.errors.join('\n')).toContain('invalid JSON')
    expect(failure.keptHash).toBe(policyHashOf(policyOf(ALLOW_ALL)))
  })

  test('a schema violation: policy unchanged, errors are the loader\'s own lines', async () => {
    const stand = createStand()
    editFile(stand, { version: 1, defaultDecision: 'maybe' })

    await stand.provider.refresh()

    expect(stand.provider.current().defaultDecision).toBe('allow')
    expect(stand.failures).toHaveLength(1)
    expect(stand.failures[0]!.errors.join('\n')).toContain('defaultDecision')
  })

  test('one broken version is reported ONCE, however many checks run against it', async () => {
    const stand = createStand()
    editFile(stand, '{ not json')

    await stand.provider.refresh()
    await stand.provider.refresh()
    stand.clock.now += POLICY_RECHECK_MIN_MS
    stand.provider.maybeRefresh()
    await stand.provider.refresh()

    expect(stand.failures).toHaveLength(1)
  })

  test('a fix after a broken version swaps in and announces the hash pair from the last VALID policy', async () => {
    const stand = createStand()
    editFile(stand, '{ not json')
    await stand.provider.refresh()

    editFile(stand, DENY_ALL)
    await stand.provider.refresh()

    expect(stand.provider.current().defaultDecision).toBe('deny')
    expect(stand.reloads).toEqual([
      {
        sourcePath: SOURCE_PATH,
        hashBefore: policyHashOf(policyOf(ALLOW_ALL)),
        hashAfter: policyHashOf(policyOf(DENY_ALL)),
      },
    ])
  })

  test('a second broken version after the first is a new version and is reported again', async () => {
    const stand = createStand()
    editFile(stand, '{ broken one')
    await stand.provider.refresh()
    editFile(stand, '{ broken two')
    await stand.provider.refresh()

    expect(stand.failures).toHaveLength(2)
    expect(stand.provider.current().defaultDecision).toBe('allow')
  })

  test('the file vanished: last valid policy stays, reported once until it reappears', async () => {
    const stand = createStand()
    stand.file.text = null

    await stand.provider.refresh()
    await stand.provider.refresh()

    expect(stand.provider.current().defaultDecision).toBe('allow')
    expect(stand.failures).toHaveLength(1)
    expect(stand.failures[0]!.errors.join('\n')).toContain(SOURCE_PATH)

    editFile(stand, DENY_ALL)
    await stand.provider.refresh()
    expect(stand.provider.current().defaultDecision).toBe('deny')
    expect(stand.reloads).toHaveLength(1)
  })

  test('a same-size fix inside the same mtime tick is still picked up (coarse-mtime file systems)', async () => {
    const stand = createStand()
    // `"deny!"` and `"deny "` are the same length: broken and fixed share one version key.
    const broken = JSON.stringify(DENY_ALL).replace('"deny"', '"deny!"')
    const fixed = `${JSON.stringify(DENY_ALL)} `
    expect(broken.length).toBe(fixed.length)
    editFile(stand, broken)
    await stand.provider.refresh()
    expect(stand.failures).toHaveLength(1)
    expect(stand.provider.current().defaultDecision).toBe('allow')

    editFileSameVersion(stand, fixed)
    await stand.provider.refresh()

    expect(stand.provider.current().defaultDecision).toBe('deny')
    expect(stand.reloads).toHaveLength(1)
    expect(stand.failures).toHaveLength(1)
  })

  test('while the file is broken every check re-reads it, but an unchanged broken file is not re-reported', async () => {
    const stand = createStand()
    editFile(stand, '{ not json')
    await stand.provider.refresh()
    const readsAfterFirstFailure = stand.readCalls()

    await stand.provider.refresh()
    await stand.provider.refresh()

    expect(stand.readCalls()).toBe(readsAfterFirstFailure + 2)
    expect(stand.failures).toHaveLength(1)
  })

  test('a DIFFERENT failure under the same version key is reported again; the same one is not', async () => {
    const stand = createStand()
    editFile(stand, '{ not json')
    await stand.provider.refresh()
    // Same key, same complaint: nothing new to tell the operator.
    editFileSameVersion(stand, '{ still not json')
    await stand.provider.refresh()
    expect(stand.failures).toHaveLength(1)

    // Same key, a different complaint (valid JSON, invalid schema): worth a line.
    editFileSameVersion(stand, JSON.stringify({ version: 1, defaultDecision: 'maybe' }))
    await stand.provider.refresh()
    expect(stand.failures).toHaveLength(2)
    expect(stand.failures[1]!.errors.join('\n')).toContain('defaultDecision')
  })

  test('after a successful load the version-key short-circuit is back: no re-read on an equal key', async () => {
    const stand = createStand()
    editFile(stand, '{ not json')
    await stand.provider.refresh()
    editFile(stand, DENY_ALL)
    await stand.provider.refresh()
    const readsAfterFix = stand.readCalls()

    await stand.provider.refresh()

    expect(stand.readCalls()).toBe(readsAfterFix)
  })

  test('a stat failure other than ENOENT is a version too: reported once, policy kept', async () => {
    const failures: PolicyReloadFailure[] = []
    let statCalls = 0
    const provider = createPolicyProvider({
      initial: policyOf(ALLOW_ALL),
      sourcePath: SOURCE_PATH,
      loadOptions: { explicitPath: SOURCE_PATH, readFile: () => Promise.resolve(JSON.stringify(DENY_ALL)) },
      stat: () => {
        statCalls += 1
        return Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
      },
      onError: (failure) => failures.push(failure),
    })

    await provider.refresh()
    await provider.refresh()

    expect(statCalls).toBe(2)
    expect(provider.current().defaultDecision).toBe('allow')
    expect(failures).toHaveLength(1)
    expect(failures[0]!.errors.join('\n')).toContain('EACCES')
  })

  test('a callback that throws never breaks the provider', async () => {
    const stand = createStand()
    const throwing = createPolicyProvider({
      initial: policyOf(ALLOW_ALL),
      sourcePath: SOURCE_PATH,
      loadOptions: { explicitPath: SOURCE_PATH, readFile: () => Promise.resolve(JSON.stringify(DENY_ALL)) },
      stat: () => Promise.resolve({ mtimeMs: 2, size: 2 }),
      onReload: () => {
        throw new Error('diagnostics stream is gone')
      },
      onError: (failure) => stand.failures.push(failure),
    })

    await expect(throwing.refresh()).resolves.toBeUndefined()
    expect(throwing.current().defaultDecision).toBe('deny')
  })
})

describe('createPolicyProvider — ADR-0005: the source is pinned to the entry point\'s resolution', () => {
  test('re-reads through the SAME loadOptions, so a connect provider never reads a project file', async () => {
    const reads: string[] = []
    const provider = createPolicyProvider({
      initial: policyOf(ALLOW_ALL),
      sourcePath: '/plane/policy.json',
      // The neutralized options an agent-launched entry point resolves to.
      loadOptions: {
        env: {},
        cwd: '/plane',
        journalDir: '/plane',
        readFile: (path) => {
          reads.push(path)
          if (path === '/plane/policy.json') return Promise.resolve(JSON.stringify(DENY_ALL))
          return Promise.reject(enoent())
        },
      },
      stat: () => Promise.resolve({ mtimeMs: 2, size: 2 }),
    })

    await provider.refresh()

    expect(provider.current().defaultDecision).toBe('deny')
    expect(reads.every((path) => path.startsWith('/plane/'))).toBe(true)
  })

  test('a re-read that resolves to a DIFFERENT file is refused, not swapped in', async () => {
    const failures: PolicyReloadFailure[] = []
    const provider = createPolicyProvider({
      initial: policyOf(ALLOW_ALL),
      sourcePath: '/plane/policy.json',
      loadOptions: {
        env: {},
        cwd: '/project',
        journalDir: '/plane',
        // A project-level file has appeared since the home-level one was loaded.
        readFile: (path) =>
          path === '/project/.mcp-journal/policy.json'
            ? Promise.resolve(JSON.stringify(DENY_ALL))
            : Promise.resolve(JSON.stringify(ALLOW_ALL)),
      },
      stat: () => Promise.resolve({ mtimeMs: 2, size: 2 }),
      onError: (failure) => failures.push(failure),
    })

    await provider.refresh()

    expect(provider.current().defaultDecision).toBe('allow')
    expect(failures).toHaveLength(1)
    expect(failures[0]!.errors.join('\n')).toContain('/project/.mcp-journal/policy.json')
  })

  test('with only the readFile seam injected, the version is derived from that reader', async () => {
    let text = JSON.stringify(ALLOW_ALL)
    const reloads: PolicyReloadEvent[] = []
    const provider = createPolicyProvider({
      initial: policyOf(ALLOW_ALL),
      sourcePath: SOURCE_PATH,
      loadOptions: { explicitPath: SOURCE_PATH, readFile: () => Promise.resolve(text) },
      onReload: (event) => reloads.push(event),
    })

    await provider.refresh()
    expect(reloads).toEqual([])

    text = JSON.stringify(DENY_ALL)
    await provider.refresh()
    expect(provider.current().defaultDecision).toBe('deny')
    expect(reloads).toHaveLength(1)
  })
})

describe('createPolicyProvider — a higher-priority candidate created after binding (shadowing)', () => {
  const PROJECT_PATH = '/plane/.mcp-journal/policy.json'

  test('a preceding candidate that appears is reported ONCE, and the bound policy is never re-targeted', async () => {
    const stand = createStand({ precedingCandidates: [PROJECT_PATH] })
    await stand.provider.refresh()
    expect(stand.shadowed).toEqual([])

    stand.shadowing.add(PROJECT_PATH)
    await stand.provider.refresh()
    await stand.provider.refresh()
    stand.clock.now += POLICY_RECHECK_MIN_MS
    stand.provider.maybeRefresh()
    await settleScheduledCheck()

    expect(stand.shadowed).toEqual([
      { shadowingPath: PROJECT_PATH, sourcePath: SOURCE_PATH, keptHash: policyHashOf(policyOf(ALLOW_ALL)) },
    ])
    expect(stand.provider.current().defaultDecision).toBe('allow')
    expect(stand.provider.sourcePath).toBe(SOURCE_PATH)
    expect(stand.failures).toEqual([])
  })

  test('once it disappears the provider goes quiet, and a later reappearance is reported again', async () => {
    const stand = createStand({ precedingCandidates: [PROJECT_PATH] })
    stand.shadowing.add(PROJECT_PATH)
    await stand.provider.refresh()
    expect(stand.shadowed).toHaveLength(1)

    stand.shadowing.delete(PROJECT_PATH)
    await stand.provider.refresh()
    expect(stand.shadowed).toHaveLength(1)

    stand.shadowing.add(PROJECT_PATH)
    await stand.provider.refresh()
    expect(stand.shadowed).toHaveLength(2)
  })

  test('the FIRST existing candidate in resolution order is the one named', async () => {
    const ENV_PATH = '/elsewhere/policy.json'
    const stand = createStand({ precedingCandidates: [ENV_PATH, PROJECT_PATH] })
    stand.shadowing.add(PROJECT_PATH)
    await stand.provider.refresh()
    expect(stand.shadowed.at(-1)?.shadowingPath).toBe(PROJECT_PATH)

    // A higher-priority one appearing on top is a change worth another line.
    stand.shadowing.add(ENV_PATH)
    await stand.provider.refresh()
    expect(stand.shadowed.at(-1)?.shadowingPath).toBe(ENV_PATH)
    expect(stand.shadowed).toHaveLength(2)
  })

  test('the bound file keeps hot-reloading while shadowed', async () => {
    const stand = createStand({ precedingCandidates: [PROJECT_PATH] })
    stand.shadowing.add(PROJECT_PATH)
    await stand.provider.refresh()

    editFile(stand, DENY_ALL)
    await stand.provider.refresh()

    expect(stand.provider.current().defaultDecision).toBe('deny')
    expect(stand.reloads).toHaveLength(1)
    expect(stand.shadowed).toHaveLength(1)
  })
})

describe('staticPolicyProvider / toPolicyProvider / mapPolicyProvider', () => {
  test('a static provider always returns the same object and never reloads', async () => {
    const policy = policyOf(ALLOW_ALL)
    const provider = staticPolicyProvider(policy)

    provider.maybeRefresh()
    await provider.refresh()

    expect(provider.current()).toBe(policy)
    expect(provider.sourcePath).toBe(STATIC_POLICY_SOURCE)
  })

  test('toPolicyProvider wraps a plain value and passes a provider through untouched', () => {
    const policy = policyOf(ALLOW_ALL)
    const provider = staticPolicyProvider(policy)

    expect(isPolicyProvider(policy)).toBe(false)
    expect(isPolicyProvider(provider)).toBe(true)
    expect(toPolicyProvider(provider)).toBe(provider)
    expect(toPolicyProvider(policy).current()).toBe(policy)
  })

  test('mapPolicyProvider derives per source identity: same input, same output object', async () => {
    const stand = createStand()
    let transforms = 0
    const mapped = mapPolicyProvider(stand.provider, (policy) => {
      transforms += 1
      return { ...policy, journal: { ...policy.journal, failClosed: true } }
    })

    const first = mapped.current()
    expect(mapped.current()).toBe(first)
    expect(first.journal.failClosed).toBe(true)
    expect(transforms).toBe(1)
    expect(mapped.sourcePath).toBe(SOURCE_PATH)

    editFile(stand, DENY_ALL)
    await mapped.refresh()
    expect(mapped.current().defaultDecision).toBe('deny')
    expect(mapped.current().journal.failClosed).toBe(true)
    expect(transforms).toBe(2)
  })
})
