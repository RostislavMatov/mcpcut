import { describe, expect, test } from 'vitest'
import type { RunRequest } from '../../src/tui/model.js'
import { createRemoteDispatch } from '../../src/tui/remote/dispatch.js'
import type { RemoteClient, RemoteIo } from '../../src/tui/remote/client.js'
import { createRemoteSessionSeams } from '../../src/cli/tui-remote.js'
import { createTokenCell, executeEffect, type EffectDeps } from '../../src/tui/runtime-effects.js'
import { runResultOf } from '../tui/support/effects-harness.js'

/**
 * `createRemoteSessionSeams` (ADR-0014, security review HIGH — a network blip
 * must not sign the operator out): the small revoked-flag cell
 * `src/cli/tui-remote.ts` wires between `createRemoteDispatch`'s
 * `onUnauthorized` and `SessionDeps.isFresh`/`resolve`.
 *
 * Exercised here through the REAL `executeEffect` (not a stand-in), because
 * the property under test is end-to-end: what the runtime does across two
 * consecutive effects sharing one `EffectDeps`, exactly as a console's whole
 * session lives across many effects.
 */

const RUN_REQUEST: RunRequest = { actionId: 'status', argv: ['status'], display: ['status'] }

function fakeClient(overrides: Partial<RemoteClient> = {}): RemoteClient {
  return {
    state: () => Promise.resolve({ ok: true, value: { api: 1, firstRun: false } }),
    whoami: () => Promise.resolve({ ok: true, value: { name: 'alice', role: 'owner' } }),
    setup: () => Promise.resolve({ ok: true, value: { name: 'alice', token: 't', journaled: true } }),
    run: () => Promise.resolve(0),
    ...overrides,
  }
}

/** One `EffectDeps` wired the same way `runRemoteTui` wires one, for one whole test's "session". */
function remoteDeps(client: RemoteClient, token: string): EffectDeps {
  const session = createRemoteSessionSeams(client)
  const cell = createTokenCell()
  cell.set(token)
  return {
    dispatch: createRemoteDispatch(client, { onUnauthorized: session.onUnauthorized }),
    dispatchOptions: {},
    env: {},
    token: cell,
    resolve: session.resolve,
    isFresh: session.isFresh,
  }
}

describe('a network blip survives: the session outlives a failed run', () => {
  test('a run whose request never reaches the server fails that run only; the next run succeeds with no re-sign-in, one request each', async () => {
    let runCalls = 0
    const client = fakeClient({
      run: (_request, _token, io: RemoteIo) => {
        runCalls += 1
        if (runCalls === 1) {
          io.stderr.write('could not reach the remote console: ECONNREFUSED\n')
          return Promise.resolve(1)
        }
        return Promise.resolve(0)
      },
    })
    const deps = remoteDeps(client, 'mcpa_tok')

    const first = await executeEffect({ kind: 'run', request: RUN_REQUEST }, deps)
    expect(runResultOf(first).result.exitCode).not.toBe(0)
    expect(deps.token.get()).toBe('mcpa_tok')

    const second = await executeEffect({ kind: 'run', request: RUN_REQUEST }, deps)

    expect(second).not.toEqual({ kind: 'session-lost' })
    expect(runResultOf(second).result.exitCode).toBe(0)
    // One HTTP request per run — no freshness pre-check doubling it (item e).
    expect(runCalls).toBe(2)
  })
})

describe('an unauthorized run loses the session on the NEXT effect, not the run that reported it', () => {
  test('the failing run itself shows the server message; only the following effect answers session-lost; signing in again clears it', async () => {
    let authorized = true
    let whoamiCalls = 0
    const client = fakeClient({
      whoami: () => {
        whoamiCalls += 1
        return Promise.resolve({ ok: true, value: { name: 'alice', role: 'owner' } })
      },
      run: (_request, _token, io: RemoteIo, onRefusal) => {
        if (authorized) return Promise.resolve(0)
        io.stderr.write('nope\n')
        onRefusal?.('unauthorized')
        return Promise.resolve(1)
      },
    })
    const deps = remoteDeps(client, 'mcpa_tok')

    authorized = false
    const first = await executeEffect({ kind: 'run', request: RUN_REQUEST }, deps)
    expect(runResultOf(first).result.exitCode).not.toBe(0)
    expect(runResultOf(first).result.stderr).toContain('nope')
    // The refused run answers on its own; it never asks `whoami` for freshness.
    expect(whoamiCalls).toBe(0)

    const second = await executeEffect({ kind: 'run', request: RUN_REQUEST }, deps)
    expect(second).toEqual({ kind: 'session-lost' })
    expect(deps.token.get()).toBeUndefined()
    // The freshness check that noticed the loss was local too — no `whoami`.
    expect(whoamiCalls).toBe(0)

    authorized = true
    deps.token.set('mcpa_tok2')
    const signinMsg = await executeEffect({ kind: 'signin', token: 'mcpa_tok2' }, deps)
    expect(signinMsg).toEqual({
      kind: 'signin-result',
      result: { kind: 'ok', name: 'alice', role: 'owner' },
    })
    expect(whoamiCalls).toBe(1)

    const third = await executeEffect({ kind: 'run', request: RUN_REQUEST }, deps)
    expect(runResultOf(third).result.exitCode).toBe(0)
  })
})

describe('a local console is unaffected: no `isFresh`/`onUnauthorized` wiring at all', () => {
  test('a bare EffectDeps without the remote seams behaves exactly as documented elsewhere (nothing to prove here beyond compiling)', () => {
    // Compile-time pin: `EffectDeps`/`SessionDeps` still accept an object with
    // neither `resolve` nor `isFresh` — the local console's own tests already
    // cover the runtime behaviour; this file only owns the remote wiring.
    const deps: EffectDeps = { dispatch: async () => 0, dispatchOptions: {}, env: {}, token: createTokenCell() }
    expect(deps.resolve).toBeUndefined()
    expect(deps.isFresh).toBeUndefined()
  })
})
