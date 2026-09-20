import { describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../../src/admin/constants.js'
import type { CliIo, DispatchOptions } from '../../../src/cli/dispatch-types.js'
import { createRemoteDispatch } from '../../../src/tui/remote/dispatch.js'
import type { RemoteClient, RemoteIo } from '../../../src/tui/remote/client.js'

/**
 * The remote `DispatchFn` (ADR-0014, plan wave 2 task 2): the console's own
 * `dispatch()` contract, backed by `POST run` instead of `cli.ts`'s router.
 */

const SENTINEL_TOKEN = 'mcpa_dispatch-sentinel'

function recordingIo(): CliIo & { out(): string; err(): string } {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    out: () => stdout.join(''),
    err: () => stderr.join(''),
  }
}

function fakeClient(overrides: Partial<RemoteClient> = {}): RemoteClient {
  return {
    state: () => Promise.resolve({ ok: true, value: { api: 1, firstRun: false } }),
    whoami: () => Promise.resolve({ ok: true, value: { name: 'alice', role: 'owner' } }),
    setup: () => Promise.resolve({ ok: true, value: { name: 'alice', token: 't', journaled: true } }),
    run: () => Promise.resolve(0),
    ...overrides,
  }
}

function optionsWithToken(token: string | undefined): DispatchOptions {
  return { admin: { env: token === undefined ? {} : { [ADMIN_TOKEN_ENV_VAR]: token } } }
}

describe('createRemoteDispatch', () => {
  test('runs the argv through the client with the seam token, and returns its exit code', async () => {
    let seenArgv: readonly string[] | undefined
    let seenToken: string | undefined
    const client = fakeClient({
      run: (request, token) => {
        seenArgv = request.argv
        seenToken = token
        return Promise.resolve(3)
      },
    })
    const dispatch = createRemoteDispatch(client)
    const io = recordingIo()

    const code = await dispatch(['server', 'list'], io, optionsWithToken(SENTINEL_TOKEN))

    expect(code).toBe(3)
    expect(seenArgv).toEqual(['server', 'list'])
    expect(seenToken).toBe(SENTINEL_TOKEN)
  })

  test('streams into the io it was given', async () => {
    const client = fakeClient({
      run: (_request, _token, io: RemoteIo) => {
        io.stdout.write('hi\n')
        return Promise.resolve(0)
      },
    })
    const dispatch = createRemoteDispatch(client)
    const io = recordingIo()

    await dispatch(['status'], io, optionsWithToken(SENTINEL_TOKEN))

    expect(io.out()).toBe('hi\n')
  })

  test('no token on the options: fails quietly, without calling the client at all', async () => {
    let called = false
    const client = fakeClient({ run: () => { called = true; return Promise.resolve(0) } })
    const dispatch = createRemoteDispatch(client)
    const io = recordingIo()

    const code = await dispatch(['status', '--json'], io, optionsWithToken(undefined))

    expect(called).toBe(false)
    expect(code).not.toBe(0)
    expect(io.out()).toBe('')
    expect(io.err()).toBe('')
  })

  test('an empty-string token is the same as none: no request', async () => {
    let called = false
    const client = fakeClient({ run: () => { called = true; return Promise.resolve(0) } })
    const dispatch = createRemoteDispatch(client)
    const io = recordingIo()

    await dispatch(['status'], io, optionsWithToken(''))

    expect(called).toBe(false)
  })

  test('no options at all (undefined admin seam): fails quietly too', async () => {
    let called = false
    const client = fakeClient({ run: () => { called = true; return Promise.resolve(0) } })
    const dispatch = createRemoteDispatch(client)
    const io = recordingIo()

    const code = await dispatch(['status'], io)

    expect(called).toBe(false)
    expect(code).not.toBe(0)
  })

  test('a vault-set-like run reads its secret from readSecretInput and sends it as stdin', async () => {
    let seenStdin: string | undefined
    const client = fakeClient({
      run: (request) => {
        seenStdin = request.stdin
        return Promise.resolve(0)
      },
    })
    const dispatch = createRemoteDispatch(client)
    const io = recordingIo()
    const options: DispatchOptions = {
      ...optionsWithToken(SENTINEL_TOKEN),
      vault: { readSecretInput: () => Promise.resolve('the-secret') },
    }

    await dispatch(['vault', 'set', 'x'], io, options)

    expect(seenStdin).toBe('the-secret')
  })

  test('calls `onUnauthorized` when, and only when, the client reports an `unauthorized` refusal for this run (ADR-0014 HIGH review)', async () => {
    const client = fakeClient({
      run: (_request, _token, _io, onRefusal) => {
        onRefusal?.('unauthorized')
        return Promise.resolve(1)
      },
    })
    let unauthorizedCalls = 0
    const dispatch = createRemoteDispatch(client, { onUnauthorized: () => { unauthorizedCalls += 1 } })
    const io = recordingIo()

    await dispatch(['status'], io, optionsWithToken(SENTINEL_TOKEN))

    expect(unauthorizedCalls).toBe(1)
  })

  test('does NOT call `onUnauthorized` for a different refusal kind', async () => {
    const client = fakeClient({
      run: (_request, _token, _io, onRefusal) => {
        onRefusal?.('forbidden')
        return Promise.resolve(1)
      },
    })
    let called = false
    const dispatch = createRemoteDispatch(client, { onUnauthorized: () => { called = true } })
    const io = recordingIo()

    await dispatch(['status'], io, optionsWithToken(SENTINEL_TOKEN))

    expect(called).toBe(false)
  })

  test('does NOT call `onUnauthorized` for a network failure (no refusal at all)', async () => {
    const client = fakeClient({ run: () => Promise.resolve(1) })
    let called = false
    const dispatch = createRemoteDispatch(client, { onUnauthorized: () => { called = true } })
    const io = recordingIo()

    await dispatch(['status'], io, optionsWithToken(SENTINEL_TOKEN))

    expect(called).toBe(false)
  })

  test('does NOT call `onUnauthorized` for a non-zero exit with no refusal', async () => {
    const client = fakeClient({ run: () => Promise.resolve(7) })
    let called = false
    const dispatch = createRemoteDispatch(client, { onUnauthorized: () => { called = true } })
    const io = recordingIo()

    const code = await dispatch(['status'], io, optionsWithToken(SENTINEL_TOKEN))

    expect(code).toBe(7)
    expect(called).toBe(false)
  })

  test('no deps at all (local console shape unaffected) still runs and never throws over the missing seam', async () => {
    const client = fakeClient({
      run: (_request, _token, _io, onRefusal) => {
        onRefusal?.('unauthorized')
        return Promise.resolve(0)
      },
    })
    const dispatch = createRemoteDispatch(client)
    const io = recordingIo()

    const code = await dispatch(['status'], io, optionsWithToken(SENTINEL_TOKEN))

    expect(code).toBe(0)
  })

  test('an ordinary run with no readSecretInput sends no stdin field at all', async () => {
    let sawStdinKey = false
    const client = fakeClient({
      run: (request) => {
        sawStdinKey = 'stdin' in request
        return Promise.resolve(0)
      },
    })
    const dispatch = createRemoteDispatch(client)
    const io = recordingIo()

    await dispatch(['server', 'list'], io, optionsWithToken(SENTINEL_TOKEN))

    expect(sawStdinKey).toBe(false)
  })
})
