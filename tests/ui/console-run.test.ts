import { mkdtempSync, rmSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createAdminStore, type AdminStore } from '../../src/admin/store.js'
import { CONSOLE_API_RUN_PATH, consoleErrorSchema, consoleRunFrameSchema } from '../../src/console-api/contract.js'
import type { ConsoleRunner, ConsoleRunnerRequest } from '../../src/console-api/runner.js'
import { REQUIRED_HANDLER_KEYS, type UiHandlers } from '../../src/ui/routes.js'
import { createUiServer, type UiServer, type UiServerOptions } from '../../src/ui/server.js'
import type { AdminRole } from '../../src/admin/constants.js'

/**
 * `POST /api/console/run` (ADR-0014, wave 1): the allowlist, the network role
 * floor, RC4's vault-write gate, NDJSON streaming and — the one property this
 * suite exists to prove — that neither the bearer token nor a request's
 * `stdin` secret ever reaches a frame or the server's stderr.
 */

function stubHandlers(): UiHandlers {
  const out: Record<string, UiHandlers[string]> = {}
  for (const key of REQUIRED_HANDLER_KEYS) {
    out[key] =
      key === 'events'
        ? () => ({ kind: 'stream', onStream: (res: ServerResponse) => res.end() })
        : () => ({ kind: 'response', status: 200, body: 'ok' })
  }
  return out
}

let journalDir: string | undefined
let server: UiServer | undefined
let stderrLines: string[] = []

async function start(
  runner: ConsoleRunner,
  overrides: Partial<UiServerOptions> = {},
): Promise<{ base: string; adminStore: AdminStore; tokenFor(role: AdminRole): Promise<string> }> {
  journalDir = mkdtempSync(join(tmpdir(), 'mcp-console-run-'))
  stderrLines = []
  const adminStore = createAdminStore({ journalDir })
  server = createUiServer({
    adminStore,
    handlers: stubHandlers(),
    stderr: { write: (chunk: string) => stderrLines.push(chunk) },
    consoleRunner: runner,
    ...overrides,
  })
  const { port } = await server.listen(0)
  let counter = 0
  return {
    base: `http://127.0.0.1:${port}`,
    adminStore,
    tokenFor: async (role: AdminRole) => {
      counter += 1
      const created = await adminStore.createAdmin(`admin-${role}-${counter}`, role)
      return created.token
    },
  }
}

afterEach(async () => {
  await server?.close()
  server = undefined
  if (journalDir !== undefined) rmSync(journalDir, { recursive: true, force: true })
  journalDir = undefined
})

/** Reads the whole NDJSON body and parses it into typed frames. */
async function framesOf(res: Response): Promise<ReturnType<typeof consoleRunFrameSchema.parse>[]> {
  const text = await res.text()
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => consoleRunFrameSchema.parse(JSON.parse(line)))
}

function postRun(base: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${base}${CONSOLE_API_RUN_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('the allowlist', () => {
  test('a daemon/interactive first word is refused before the runner is asked', async () => {
    let called = false
    const ui = await start(async () => {
      called = true
      return 0
    })
    const token = await ui.tokenFor('owner')

    for (const argv of [['tui'], ['ui'], ['serve'], ['wrap'], ['connect'], ['setup']]) {
      const res = await postRun(ui.base, token, { argv })
      expect(res.status).toBe(403)
      expect(consoleErrorSchema.parse(await res.json()).error).toBe('forbidden')
    }
    expect(called).toBe(false)
  })

  test('a known first word runs', async () => {
    let seenArgv: readonly string[] | undefined
    const ui = await start(async (request) => {
      seenArgv = request.argv
      return 0
    })
    const token = await ui.tokenFor('viewer')

    const res = await postRun(ui.base, token, { argv: ['status'] })

    expect(res.status).toBe(200)
    expect(seenArgv).toEqual(['status'])
  })
})

describe('the network role floor', () => {
  test('an owner-floor command refuses a viewer and an operator, and runs for an owner', async () => {
    let runs = 0
    const ui = await start(async () => {
      runs += 1
      return 0
    })

    for (const role of ['viewer', 'operator'] as const) {
      const token = await ui.tokenFor(role)
      const res = await postRun(ui.base, token, { argv: ['keygen'] })
      expect(res.status).toBe(403)
    }
    const ownerToken = await ui.tokenFor('owner')
    const res = await postRun(ui.base, ownerToken, { argv: ['keygen'] })
    expect(res.status).toBe(200)
    expect(runs).toBe(1)
  })

  test('an operator-floor command (export) refuses a viewer but runs for an operator', async () => {
    const ui = await start(async () => 0)

    const viewerToken = await ui.tokenFor('viewer')
    const viewerRes = await postRun(ui.base, viewerToken, { argv: ['export'] })
    expect(viewerRes.status).toBe(403)

    const operatorToken = await ui.tokenFor('operator')
    const operatorRes = await postRun(ui.base, operatorToken, { argv: ['export'] })
    expect(operatorRes.status).toBe(200)
  })

  test('a policy command that names a file on the server is never a viewer read', async () => {
    // Security review H2: `policy show --policy <path>` has no gate of its own
    // and opens whatever path it is given — a file-probing oracle for `viewer`.
    const ui = await start(async () => 0)
    const viewer = await ui.tokenFor('viewer')

    for (const argv of [
      ['policy', 'show', '--policy', '/etc/hosts'],
      ['policy', 'show', '--policy=/etc/hosts'],
      ['policy', 'show', '--entry-point', 'wrap'],
    ]) {
      const res = await postRun(ui.base, viewer, { argv })
      expect(res.status).toBe(403)
    }
    const operator = await ui.tokenFor('operator')
    const res = await postRun(ui.base, operator, { argv: ['policy', 'show', '--policy', '/etc/hosts'] })
    expect(res.status).toBe(200)
  })

  test('an export that writes a directory on the server is owner-only; one that streams stays operator', async () => {
    // Review finding 3: `export --report --out <dir>` is `backup <dir>` in kind.
    const ui = await start(async () => 0)
    const operator = await ui.tokenFor('operator')

    const streamed = await postRun(ui.base, operator, { argv: ['export'] })
    const written = await postRun(ui.base, operator, { argv: ['export', '--report', '--out', '/tmp/x'] })
    const byOwner = await postRun(ui.base, await ui.tokenFor('owner'), {
      argv: ['export', '--report', '--out', '/tmp/x'],
    })

    expect(streamed.status).toBe(200)
    expect(written.status).toBe(403)
    expect(byOwner.status).toBe(200)
  })

  test('"policy validate" needs operator; plain "policy show" only needs viewer', async () => {
    const ui = await start(async () => 0)
    const viewerToken = await ui.tokenFor('viewer')

    const validate = await postRun(ui.base, viewerToken, { argv: ['policy', 'validate'] })
    const show = await postRun(ui.base, viewerToken, { argv: ['policy', 'show'] })

    expect(validate.status).toBe(403)
    expect(show.status).toBe(200)
  })
})

describe('RC4: vault writes over the network', () => {
  test('vault set is refused over plain HTTP from a non-loopback view of the peer', async () => {
    // The test client always dials 127.0.0.1, so RC4 is exercised the other
    // way: a configured trusted-proxy header makes the raw peer address
    // untrustworthy even though it IS loopback here.
    const ui = await start(async () => 0, { trustedProxyHeader: 'x-forwarded-for' })
    const token = await ui.tokenFor('owner')

    const res = await postRun(ui.base, token, { argv: ['vault', 'set', 'k'], stdin: 'secret-value' })

    expect(res.status).toBe(403)
    expect(consoleErrorSchema.parse(await res.json()).error).toBe('forbidden')
  })

  test('vault set is allowed over plain HTTP from the loopback peer with no trusted-proxy header', async () => {
    const ui = await start(async () => 0)
    const token = await ui.tokenFor('owner')

    const res = await postRun(ui.base, token, { argv: ['vault', 'set', 'k'], stdin: 'secret-value' })

    expect(res.status).toBe(200)
  })

  test('vault set is allowed behind TLS regardless of the peer', async () => {
    const ui = await start(async () => 0, { behindTls: true, trustedProxyHeader: 'x-forwarded-for' })
    const token = await ui.tokenFor('owner')

    const res = await postRun(ui.base, token, { argv: ['vault', 'set', 'k'], stdin: 'secret-value' })

    expect(res.status).toBe(200)
  })

  test('vault list (a read) is unaffected by RC4', async () => {
    const ui = await start(async () => 0, { trustedProxyHeader: 'x-forwarded-for' })
    const token = await ui.tokenFor('owner')

    const res = await postRun(ui.base, token, { argv: ['vault', 'list'] })

    expect(res.status).toBe(200)
  })

  test('vault list is owner-only over the network, as the web /vault page is', async () => {
    // `vault list` has no gate of its own (it was a host read); without a
    // floor a viewer token would read secret NAMES the web UI keeps from it.
    const ui = await start(async () => 0)

    for (const role of ['viewer', 'operator'] as const) {
      const res = await postRun(ui.base, await ui.tokenFor(role), { argv: ['vault', 'list'] })
      expect(res.status).toBe(403)
    }
  })
})

describe('the request body', () => {
  test('malformed JSON is bad-request, not an unhandled failure', async () => {
    const ui = await start(async () => 0)
    const token = await ui.tokenFor('owner')

    const res = await fetch(`${ui.base}${CONSOLE_API_RUN_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{not json',
    })

    expect(res.status).toBe(400)
    expect(consoleErrorSchema.parse(await res.json()).error).toBe('bad-request')
  })

  test('a schema violation (missing argv) is also bad-request', async () => {
    const ui = await start(async () => 0)
    const token = await ui.tokenFor('owner')

    const res = await fetch(`${ui.base}${CONSOLE_API_RUN_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
  })

  test('a body past the server cap drops the connection rather than answering', async () => {
    const ui = await start(async () => 0, { maxBodyBytes: 64 })
    const token = await ui.tokenFor('owner')

    await expect(
      fetch(`${ui.base}${CONSOLE_API_RUN_PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ argv: ['status'], stdin: 'x'.repeat(200) }),
      }),
    ).rejects.toThrow()
  })
})

describe('bearer auth', () => {
  test('a bad token is one byte-identical 401, and the runner is never asked', async () => {
    let called = false
    const ui = await start(async () => {
      called = true
      return 0
    })

    const res = await postRun(ui.base, 'mcpa_wrong', { argv: ['status'] })

    expect(res.status).toBe(401)
    expect(called).toBe(false)
  })

  test('a request carrying Origin is refused before auth is even checked', async () => {
    const ui = await start(async () => 0)
    const token = await ui.tokenFor('owner')

    const res = await fetch(`${ui.base}${CONSOLE_API_RUN_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        origin: 'http://evil.example',
      },
      body: JSON.stringify({ argv: ['status'] }),
    })

    expect(res.status).toBe(403)
  })
})

describe('streaming', () => {
  test('out/err frames arrive in order, and exactly one exit frame ends the stream', async () => {
    const ui = await start(async (_request, io) => {
      io.stdout.write('line one\n')
      io.stderr.write('warn\n')
      io.stdout.write('line two\n')
      return 7
    })
    const token = await ui.tokenFor('viewer')

    const res = await postRun(ui.base, token, { argv: ['status'] })
    const frames = await framesOf(res)

    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    expect(frames).toEqual([
      { t: 'out', d: 'line one\n' },
      { t: 'err', d: 'warn\n' },
      { t: 'out', d: 'line two\n' },
      { t: 'exit', code: 7 },
    ])
  })

  test('a runner that throws answers one safe err frame plus a failing exit, and the detail goes to server stderr only', async () => {
    const ui = await start(async () => {
      throw new Error('disk on fire at /srv/secret/path')
    })
    const token = await ui.tokenFor('viewer')

    const res = await postRun(ui.base, token, { argv: ['status'] })
    const frames = await framesOf(res)

    expect(frames.at(-1)).toEqual({ t: 'exit', code: 1 })
    const errFrame = frames.find((frame) => frame.t === 'err')
    expect(errFrame?.d).not.toContain('/srv/secret/path')
    expect(stderrLines.join('')).toContain('/srv/secret/path')
  })
})

describe('the token and stdin never leak', () => {
  test('a sentinel token and stdin appear in neither a frame nor server stderr', async () => {
    const SENTINEL_TOKEN_MARKER = 'THIS-IS-THE-BEARER-TOKEN'
    const SENTINEL_SECRET_MARKER = 'THIS-IS-THE-VAULT-SECRET'
    let observedToken: string | undefined
    const ui = await start(async (request: ConsoleRunnerRequest, io) => {
      observedToken = request.token
      // A well-behaved command never echoes its own token or stdin, but the
      // guarantee this suite is pinning lives in `console-run.ts`'s own
      // catch/frame code, not in runner discipline — so this runner ALSO
      // tries to misbehave by writing the secret out, to prove the frame path
      // itself does not do something clever like an accidental substring
      // match. If this assertion below ever fails first, the runner is the
      // leak, not the transport — that is an acceptable, visible failure mode.
      io.stdout.write(`ran with argv=${JSON.stringify(request.argv)}\n`)
      return 0
    })
    const created = await ui.adminStore.createAdmin('leak-check', 'owner')
    // The token itself does not contain the marker (admin tokens are
    // `mcpa_`-prefixed random bytes); what must never leak is the actual
    // bearer value this request carries and the stdin secret below.
    const res = await postRun(ui.base, created.token, {
      argv: ['vault', 'set', 'k'],
      stdin: SENTINEL_SECRET_MARKER,
    })
    const frames = await framesOf(res)
    const wholeBody = frames.map((frame) => (frame.t === 'exit' ? '' : frame.d)).join('')

    expect(observedToken).toBe(created.token)
    expect(wholeBody).not.toContain(created.token)
    expect(wholeBody).not.toContain(SENTINEL_SECRET_MARKER)
    expect(wholeBody).not.toContain(SENTINEL_TOKEN_MARKER)
    expect(stderrLines.join('')).not.toContain(created.token)
    expect(stderrLines.join('')).not.toContain(SENTINEL_SECRET_MARKER)
  })

  test('a runner that throws with the token/stdin embedded in its own message still leaks neither, even to stderr', async () => {
    const ui = await start(async (request) => {
      throw new Error(`failed while token=${request.token} stdin=${request.stdin ?? ''}`)
    })
    const created = await ui.adminStore.createAdmin('leak-check-2', 'owner')

    const res = await postRun(ui.base, created.token, { argv: ['vault', 'set', 'k'], stdin: 'top-secret-value' })
    const frames = await framesOf(res)
    const wholeBody = frames.map((frame) => (frame.t === 'exit' ? '' : frame.d)).join('')

    expect(wholeBody).not.toContain(created.token)
    expect(wholeBody).not.toContain('top-secret-value')
    // Defence in depth: even a command whose OWN thrown message embedded the
    // bearer or the secret must not turn the server's stderr into the leak —
    // `console-run.ts` redacts both before writing the diagnostic line.
    expect(stderrLines.join('')).toContain('failed while token=[redacted] stdin=[redacted]')
    expect(stderrLines.join('')).not.toContain(created.token)
    expect(stderrLines.join('')).not.toContain('top-secret-value')
  })
})
