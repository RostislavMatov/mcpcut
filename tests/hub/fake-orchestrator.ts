import { randomBytes } from 'node:crypto'
import type { CreateInstallInput, Orchestrator, OwnerTokenGrant } from '../../hub/src/orchestrator.js'

/**
 * A scriptable in-memory orchestrator for the hub's server tests (plan Task 5):
 * records every call, mints recognisable owner tokens, and can be told to
 * fail the next call of any method.
 */

export const FAKE_OWNER_TOKEN_PREFIX = 'mcpo_fake_'

export type FakeOrchestratorMethod = 'create' | 'rotateOwnerToken' | 'remove'

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
  calls(): readonly FakeOrchestratorCall[]
  /** Subdomains with an install right now. */
  installs(): readonly string[]
  /** Every owner token minted so far, newest last. */
  tokens(): readonly string[]
}

export function createFakeOrchestrator(): FakeOrchestrator {
  const failing = new Map<FakeOrchestratorMethod, string>()
  const log: FakeOrchestratorCall[] = []
  const live = new Set<string>()
  const minted: string[] = []

  function mint(): OwnerTokenGrant {
    const ownerToken = `${FAKE_OWNER_TOKEN_PREFIX}${randomBytes(16).toString('hex')}`
    minted.push(ownerToken)
    return { ownerToken }
  }

  function enter(method: FakeOrchestratorMethod, subdomain: string): void {
    log.push({ method, subdomain })
    const message = failing.get(method)
    if (message !== undefined) throw new Error(message)
  }

  return {
    available: true,
    fail: (method, message = `fake orchestrator: ${method} failed`) => failing.set(method, message),
    succeed: (method) => failing.delete(method),
    calls: () => [...log],
    installs: () => [...live],
    tokens: () => [...minted],
    async create(input: CreateInstallInput) {
      enter('create', input.subdomain)
      live.add(input.subdomain)
      return mint()
    },
    async rotateOwnerToken(subdomain: string) {
      enter('rotateOwnerToken', subdomain)
      return mint()
    },
    async remove(subdomain: string) {
      enter('remove', subdomain)
      live.delete(subdomain)
    },
  }
}
