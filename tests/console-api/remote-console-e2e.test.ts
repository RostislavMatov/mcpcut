import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import { setupCodePathFor } from '../../src/admin/setup-code-file.js'
import { createAdminStore } from '../../src/admin/store.js'
import { dispatch } from '../../src/cli.js'
import type { DispatchOptions } from '../../src/cli/dispatch-types.js'
import { runUi, type UiHandle } from '../../src/cli/ui-cmd.js'
import { createRemoteClient, type RemoteClient } from '../../src/tui/remote/client.js'
import { createRemoteDispatch } from '../../src/tui/remote/dispatch.js'
import { createRemoteResolve } from '../../src/tui/remote/session.js'
import { createRemoteFirstOwnerSetup } from '../../src/tui/remote/setup.js'

/**
 * Both halves of the remote console (ADR-0014) with nothing faked between
 * them: a real `ui` on an ephemeral port, the real argv dispatcher behind its
 * `POST /api/console/run`, and the real client the console would hold. The
 * halves were built against `contract.ts` by separate hands; this file is
 * where a disagreement between them would show.
 */

const LISTEN_TIMEOUT_MS = 5000
const POLL_INTERVAL_MS = 5

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined)
  }
})

interface Install {
  readonly journalDir: string
  readonly client: RemoteClient
}

const SILENT = { stdout: { write: () => undefined }, stderr: { write: () => undefined } }

async function startInstall(): Promise<Install> {
  const journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-remote-e2e-'))
  cleanups.push(() => rm(journalDir, { recursive: true, force: true }))
  let handle: UiHandle | undefined
  const exit = runUi(['--port', '0'], SILENT, {
    journalDir,
    signals: [],
    dispatch,
    // The `admin` commands of this test must read the store `ui` serves.
    dispatchOptions: { admin: { journalDir } },
    onListening: (started) => {
      handle = started
    },
  })
  exit.catch(() => undefined)
  const deadline = Date.now() + LISTEN_TIMEOUT_MS
  while (handle === undefined) {
    if (Date.now() > deadline) throw new Error('ui did not start listening')
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  const started = handle
  cleanups.push(() => started.shutdown())
  return { journalDir, client: createRemoteClient({ baseUrl: `http://127.0.0.1:${started.port}` }) }
}

function captured(): { io: typeof SILENT; out(): string; err(): string } {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { stdout: { write: (c: string) => out.push(c) }, stderr: { write: (c: string) => err.push(c) } },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

/** The options a signed-in console hands its dispatcher: the token on the `admin` seam. */
function sessionOptions(token: string): DispatchOptions {
  return { admin: { env: { [ADMIN_TOKEN_ENV_VAR]: token } } }
}

describe('remote console, end to end', () => {
  test('a fresh install reports a first run, and the code from its data dir makes the first owner', async () => {
    const install = await startInstall()
    const code = (await readFile(setupCodePathFor(install.journalDir), 'utf8')).trim()

    const before = await install.client.state()
    const made = await createRemoteFirstOwnerSetup(install.client)(code, 'kate')
    const after = await install.client.state()

    expect(before).toMatchObject({ ok: true, value: { firstRun: true } })
    expect(made).toMatchObject({ kind: 'ok', name: 'kate', journaled: true })
    expect(after).toMatchObject({ ok: true, value: { firstRun: false } })
  })

  test('a wrong code is refused and leaves the install in its first run', async () => {
    const install = await startInstall()

    const made = await createRemoteFirstOwnerSetup(install.client)('mcps_wrong', 'kate')

    expect(made.kind).toBe('refused')
    expect(await install.client.state()).toMatchObject({ ok: true, value: { firstRun: true } })
  })

  test('the minted token signs in and runs a real command under that admin', async () => {
    const install = await startInstall()
    const code = (await readFile(setupCodePathFor(install.journalDir), 'utf8')).trim()
    const made = await createRemoteFirstOwnerSetup(install.client)(code, 'kate')
    if (made.kind !== 'ok') throw new Error('setup did not answer ok')
    const run = captured()

    const resolved = await createRemoteResolve(install.client)(made.token)
    const exitCode = await createRemoteDispatch(install.client)(
      ['admin', 'list'],
      run.io,
      sessionOptions(made.token),
    )

    expect(resolved).toMatchObject({ kind: 'ok' })
    expect(exitCode).toBe(0)
    expect(run.out()).toContain('kate')
    expect(run.out()).not.toContain(made.token)
  })

  test('an admin removed on the host stops resolving on the very next request', async () => {
    const install = await startInstall()
    const store = createAdminStore({ journalDir: install.journalDir })
    await store.createAdmin('keeper', 'owner')
    const leaving = await store.createAdmin('leaving', 'viewer')
    const resolve = createRemoteResolve(install.client)
    const before = await resolve(leaving.token)

    await store.removeAdmin('leaving')
    const after = await resolve(leaving.token)

    expect(before.kind).toBe('ok')
    expect(after.kind).not.toBe('ok')
  })

  test('a viewer is refused a host operation by the network floor, with the reason on stderr', async () => {
    const install = await startInstall()
    const store = createAdminStore({ journalDir: install.journalDir })
    await store.createAdmin('keeper', 'owner')
    const viewer = await store.createAdmin('reader', 'viewer')
    const run = captured()

    const exitCode = await createRemoteDispatch(install.client)(['keygen'], run.io, sessionOptions(viewer.token))

    expect(exitCode).not.toBe(0)
    expect(run.err()).not.toBe('')
    expect(run.err()).not.toContain(viewer.token)
  })

  test('a command outside the catalogue never runs', async () => {
    const install = await startInstall()
    const owner = await createAdminStore({ journalDir: install.journalDir }).createAdmin('keeper', 'owner')
    const run = captured()

    const exitCode = await createRemoteDispatch(install.client)(['serve'], run.io, sessionOptions(owner.token))

    expect(exitCode).not.toBe(0)
  })
})
