import { describe, expect, test } from 'vitest'
import { POLICY_RECHECK_MIN_MS } from '../../src/policy/constants.js'
import type { LoadPolicyOptions } from '../../src/policy/load.js'
import { policyHashOf } from '../../src/policy/provenance.js'
import type { PolicyFileVersion, PolicyReloadEvent, PolicyReloadFailure, PolicyShadowedEvent } from '../../src/policy/reload.js'
import { NO_POLICY_SOURCE, createAwaitingPolicyProvider, type PolicyAdoptedEvent } from '../../src/policy/reload-await.js'
import { parsePolicy, type Policy } from '../../src/policy/schema.js'
import { mapPolicyProvider, type PolicyProvider } from '../../src/policy/provider.js'

/**
 * User-journey smoke 2026-09-18, M1 (owner decision of the same day: ADOPT).
 * `setup` starts `serve` before any `policy.json` exists; the operator then
 * writes one, the admin UI shows its hash and "every entry point reads this
 * file" -- and the front kept allowing everything until a restart nobody knew
 * was needed. A process that started with no policy file now watches the
 * places one may appear and, once a VALID one does, binds to it for good.
 */

const PROJECT_PATH = '/work/.mcp-journal/policy.json'
const HOME_PATH = '/home/.mcp-journal/policy.json'

const JOURNALING_ONLY = { version: 1, defaultDecision: 'allow', quarantine: { enabled: false } }
const REQUIRE_APPROVAL = { version: 1, defaultDecision: 'require-approval' }
const DENY_ALL = { version: 1, defaultDecision: 'deny' }

function policyOf(document: Record<string, unknown>): Policy {
  const result = parsePolicy(document)
  if (!result.ok) throw new Error(`test policy is invalid: ${JSON.stringify(result.error.issues)}`)
  return result.policy
}

function enoent(): Error {
  return Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
}

interface Stand {
  readonly provider: PolicyProvider
  /** path -> text; absent key = no such file. */
  readonly files: Map<string, string>
  readonly clock: { now: number }
  readonly adopted: PolicyAdoptedEvent[]
  /** A candidate that exists but was not adopted. */
  readonly rejected: PolicyReloadFailure[]
  /** Failures of the BOUND file, after adoption. */
  readonly failures: PolicyReloadFailure[]
  readonly reloads: PolicyReloadEvent[]
  readonly shadowed: PolicyShadowedEvent[]
  readonly statCalls: () => number
}

function createStand(): Stand {
  const files = new Map<string, string>()
  const clock = { now: 100_000 }
  const adopted: PolicyAdoptedEvent[] = []
  const rejected: PolicyReloadFailure[] = []
  const failures: PolicyReloadFailure[] = []
  const reloads: PolicyReloadEvent[] = []
  const shadowed: PolicyShadowedEvent[] = []
  let statCalls = 0

  const loadOptions: LoadPolicyOptions = { cwd: '/work', env: {}, journalDir: '/home/.mcp-journal' }
  const statSync = (path: string): PolicyFileVersion => {
    statCalls += 1
    const text = files.get(path)
    if (text === undefined) throw enoent()
    return { mtimeMs: text.length * 7 + 1, size: text.length }
  }
  const provider = createAwaitingPolicyProvider({
    fallback: policyOf(JOURNALING_ONLY),
    loadOptions,
    candidates: [PROJECT_PATH, HOME_PATH],
    now: () => clock.now,
    statSync,
    stat: (path) => Promise.resolve().then(() => statSync(path)),
    readFileSync: (path) => {
      const text = files.get(path)
      if (text === undefined) throw enoent()
      return text
    },
    onAdopted: (event) => adopted.push(event),
    onRejected: (failure) => rejected.push(failure),
    onError: (failure) => failures.push(failure),
    onReload: (event) => reloads.push(event),
    onShadowed: (event) => shadowed.push(event),
  })
  return { provider, files, clock, adopted, rejected, failures, reloads, shadowed, statCalls: () => statCalls }
}

/** One decision's worth of time: past the recheck cooldown, then the hot-path check. */
function nextDecision(stand: Stand): void {
  stand.clock.now += POLICY_RECHECK_MIN_MS + 1
  stand.provider.maybeRefresh()
}

describe('while no policy file exists', () => {
  test('the fallback is in force and nothing is reported', () => {
    const stand = createStand()

    nextDecision(stand)

    expect(stand.provider.current().defaultDecision).toBe('allow')
    expect(stand.provider.sourcePath).toBe(NO_POLICY_SOURCE)
    expect(stand.adopted).toEqual([])
    expect(stand.rejected).toEqual([])
  })

  test('the candidates are looked at no more often than the recheck cooldown allows', () => {
    const stand = createStand()
    nextDecision(stand)
    const afterFirst = stand.statCalls()

    stand.provider.maybeRefresh()
    stand.provider.maybeRefresh()

    expect(stand.statCalls()).toBe(afterFirst)
  })
})

describe('a policy file that appears is adopted', () => {
  test('the very decision that notices it is already made under it', () => {
    const stand = createStand()
    nextDecision(stand)
    stand.files.set(HOME_PATH, JSON.stringify(REQUIRE_APPROVAL))

    nextDecision(stand)

    expect(stand.provider.current().defaultDecision).toBe('require-approval')
    expect(stand.provider.sourcePath).toBe(HOME_PATH)
    expect(stand.adopted).toEqual([
      { sourcePath: HOME_PATH, hashBefore: policyHashOf(policyOf(JOURNALING_ONLY)), hashAfter: policyHashOf(policyOf(REQUIRE_APPROVAL)) },
    ])
  })

  test('when two appear at once the entry point’s resolution order picks', () => {
    const stand = createStand()
    stand.files.set(HOME_PATH, JSON.stringify(DENY_ALL))
    stand.files.set(PROJECT_PATH, JSON.stringify(REQUIRE_APPROVAL))

    nextDecision(stand)

    expect(stand.provider.sourcePath).toBe(PROJECT_PATH)
    expect(stand.provider.current().defaultDecision).toBe('require-approval')
  })

  test('refresh() adopts too, for callers off the hot path', async () => {
    const stand = createStand()
    stand.files.set(HOME_PATH, JSON.stringify(DENY_ALL))

    await stand.provider.refresh()

    expect(stand.provider.current().defaultDecision).toBe('deny')
    expect(stand.adopted).toHaveLength(1)
  })
})

describe('a wrapper over the awaiting provider stays a pass-through', () => {
  // Both entry points wrap the provider (`--fail-closed` mapping) before the
  // gate ever sees it, so what the gate holds is the WRAPPER.
  test('mapPolicyProvider reports the adopted file, not the path it saw when it was built', () => {
    const stand = createStand()
    const wrapped = mapPolicyProvider(stand.provider, (policy) => policy)
    expect(wrapped.sourcePath).toBe(NO_POLICY_SOURCE)

    stand.files.set(HOME_PATH, JSON.stringify(REQUIRE_APPROVAL))
    stand.clock.now += POLICY_RECHECK_MIN_MS + 1
    wrapped.maybeRefresh()

    expect(wrapped.current().defaultDecision).toBe('require-approval')
    expect(wrapped.sourcePath).toBe(HOME_PATH)
  })
})

describe('a broken file is never adopted', () => {
  test('the fallback stays in force and the failure is reported once', () => {
    const stand = createStand()
    stand.files.set(HOME_PATH, '{ not json')

    nextDecision(stand)
    nextDecision(stand)

    expect(stand.provider.current().defaultDecision).toBe('allow')
    expect(stand.provider.sourcePath).toBe(NO_POLICY_SOURCE)
    expect(stand.rejected).toHaveLength(1)
    expect(stand.rejected[0]?.sourcePath).toBe(HOME_PATH)
    expect(stand.rejected[0]?.keptHash).toBe(policyHashOf(policyOf(JOURNALING_ONLY)))
  })

  test('a schema-invalid document is a failure as well, not a partial adoption', () => {
    const stand = createStand()
    stand.files.set(HOME_PATH, JSON.stringify({ version: 1, defaultDecision: 'whatever' }))

    nextDecision(stand)

    expect(stand.provider.sourcePath).toBe(NO_POLICY_SOURCE)
    expect(stand.rejected).toHaveLength(1)
  })

  test('fixing the file gets it adopted on the next decision', () => {
    const stand = createStand()
    stand.files.set(HOME_PATH, '{ not json')
    nextDecision(stand)

    stand.files.set(HOME_PATH, JSON.stringify(DENY_ALL))
    nextDecision(stand)

    expect(stand.provider.current().defaultDecision).toBe('deny')
    expect(stand.adopted).toHaveLength(1)
  })
})

describe('once adopted, the source is pinned like any loaded policy (ADR-0005)', () => {
  function adoptedHome(): Stand {
    const stand = createStand()
    stand.files.set(HOME_PATH, JSON.stringify(REQUIRE_APPROVAL))
    nextDecision(stand)
    return stand
  }

  test('an edit of the adopted file hot-reloads', () => {
    const stand = adoptedHome()

    stand.files.set(HOME_PATH, JSON.stringify(DENY_ALL))
    nextDecision(stand)

    expect(stand.provider.current().defaultDecision).toBe('deny')
    expect(stand.reloads).toHaveLength(1)
  })

  test('a higher-priority file appearing later is reported, never switched to', () => {
    const stand = adoptedHome()

    stand.files.set(PROJECT_PATH, JSON.stringify(DENY_ALL))
    nextDecision(stand)

    expect(stand.provider.sourcePath).toBe(HOME_PATH)
    expect(stand.provider.current().defaultDecision).toBe('require-approval')
    expect(stand.shadowed.map((event) => event.shadowingPath)).toEqual([PROJECT_PATH])
  })

  test('the adopted file vanishing keeps the last valid policy, not the fallback', () => {
    const stand = adoptedHome()

    stand.files.delete(HOME_PATH)
    nextDecision(stand)

    expect(stand.provider.current().defaultDecision).toBe('require-approval')
    expect(stand.failures).toHaveLength(1)
    expect(stand.adopted).toHaveLength(1)
  })
})
