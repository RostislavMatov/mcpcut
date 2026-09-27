import { randomBytes } from 'node:crypto'
import type { CreateInstallInput, InstallInspection, Orchestrator, OwnerTokenGrant } from '../../hub/src/orchestrator.js'

/**
 * A scriptable in-memory orchestrator for the hub's server tests (plan Task 5):
 * records every call, mints recognisable owner tokens, can be told to fail
 * the next call of any method, and can HOLD a method — every later call waits
 * until `release` (plan `hosted-path-and-ops`, Task A: a create that hangs
 * must not hold the GitHub callback). Installs run or are stopped like the
 * provisioner's, and report a settable last activity while they run (Task C).
 */

export const FAKE_OWNER_TOKEN_PREFIX = 'mcpo_fake_'

export type FakeOrchestratorMethod = 'create' | 'rotateOwnerToken' | 'remove' | 'stop' | 'start' | 'inspect'

/** One install the fake holds: whether it runs and what `inspect` reports as its last activity while it does. */
export interface FakeInstall {
  readonly running: boolean
  readonly lastActivityAt: string | null
}

export interface FakeOrchestratorCall {
  readonly method: FakeOrchestratorMethod
  readonly subdomain: string
}

export interface FakeOrchestrator extends Orchestrator {
  available: boolean
  /**
   * Makes every later call of `method` reject until `succeed(method)`, with
   * `message` as the error's message when given (a leak probe: a real
   * orchestrator's error may quote a token it should not have).
   */
  fail(method: FakeOrchestratorMethod, message?: string): void
  succeed(method: FakeOrchestratorMethod): void
  /** Every later call of `method` waits (after being recorded) until `release(method)`. */
  hold(method: FakeOrchestratorMethod): void
  release(method: FakeOrchestratorMethod): void
  calls(): readonly FakeOrchestratorCall[]
  /** Subdomains with an install right now. */
  installs(): readonly string[]
  /** Puts an install in place without a call, as one a previous hub run created (running, no activity, by default). */
  addInstall(subdomain: string, install?: Partial<FakeInstall>): void
  /** The install as the fake holds it, or `undefined`. */
  install(subdomain: string): FakeInstall | undefined
  /** Every owner token minted so far, newest last. */
  tokens(): readonly string[]
}

interface Gate {
  readonly opened: Promise<void>
  readonly open: () => void
}

function gate(): Gate {
  let open: () => void = () => undefined
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

export function createFakeOrchestrator(): FakeOrchestrator {
  const failing = new Map<FakeOrchestratorMethod, string>()
  const held = new Map<FakeOrchestratorMethod, Gate>()
  const log: FakeOrchestratorCall[] = []
  const live = new Map<string, FakeInstall>()
  const minted: string[] = []

  function mint(): OwnerTokenGrant {
    const ownerToken = `${FAKE_OWNER_TOKEN_PREFIX}${randomBytes(16).toString('hex')}`
    minted.push(ownerToken)
    return { ownerToken }
  }

  async function enter(method: FakeOrchestratorMethod, subdomain: string): Promise<void> {
    log.push({ method, subdomain })
    const waiting = held.get(method)
    if (waiting !== undefined) await waiting.opened
    const message = failing.get(method)
    if (message !== undefined) throw new Error(message)
  }

  /** Like the provisioner: idempotent on the install, `not-found` without one. */
  function setRunning(subdomain: string, running: boolean): void {
    const install = live.get(subdomain)
    if (install === undefined) throw new Error(`fake orchestrator: no install for ${subdomain} (not-found)`)
    live.set(subdomain, { ...install, running })
  }

  return {
    available: true,
    fail: (method, message = `fake orchestrator: ${method} failed`) => failing.set(method, message),
    succeed: (method) => failing.delete(method),
    hold: (method) => {
      if (!held.has(method)) held.set(method, gate())
    },
    release: (method) => {
      held.get(method)?.open()
      held.delete(method)
    },
    calls: () => [...log],
    installs: () => [...live.keys()],
    addInstall: (subdomain, install = {}) => live.set(subdomain, { running: true, lastActivityAt: null, ...install }),
    install: (subdomain) => live.get(subdomain),
    tokens: () => [...minted],
    async create(input: CreateInstallInput) {
      await enter('create', input.subdomain)
      live.set(input.subdomain, { running: true, lastActivityAt: null })
      return mint()
    },
    async rotateOwnerToken(subdomain: string) {
      await enter('rotateOwnerToken', subdomain)
      return mint()
    },
    async remove(subdomain: string) {
      await enter('remove', subdomain)
      live.delete(subdomain)
    },
    async stop(subdomain: string) {
      await enter('stop', subdomain)
      setRunning(subdomain, false)
    },
    async start(subdomain: string) {
      await enter('start', subdomain)
      setRunning(subdomain, true)
    },
    async inspect(subdomain: string): Promise<InstallInspection> {
      await enter('inspect', subdomain)
      const install = live.get(subdomain)
      if (install === undefined) return { state: 'absent', running: false, lastActivityAt: null }
      return { state: 'present', running: install.running, lastActivityAt: install.running ? install.lastActivityAt : null }
    },
  }
}
