import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { collectPersistedBytes } from '../support/persisted-bytes.js'
import { writeCorruptDatabase } from '../support/corrupt-db.js'
import { ADMINS_FILE_NAME } from '../../src/admin/constants.js'
import { createAdminStore } from '../../src/admin/store.js'
import { runUi, type UiHandle } from '../../src/cli/ui-cmd.js'
import { BOOTSTRAP_ADMIN_NAME, UI_USAGE } from '../../src/cli/ui-constants.js'
import { openInventoryStore } from '../../src/policy/inventory-store.js'
import { DEFAULT_UI_HOST, DEFAULT_UI_PORT } from '../../src/ui/constants.js'

/**
 * `mcp-journal ui` (M4 Task 16): the admin UI's process entry point, driven
 * exactly like `serve` — flags → stores → server → listen → wait → graceful
 * shutdown, with `onListening` as the test seam and a temp journal dir so the
 * real `~/.mcp-journal` is never touched.
 *
 * The daemon discipline is asserted throughout: stdout stays byte-empty for a
 * whole run, and every diagnostic — the bind warning, the listening line and
 * the one-time bootstrap credential — goes to stderr.
 */

/** Origin a browser attaches to every POST; the UI requires it on state changes. */
const UI_TEST_ORIGIN = 'http://127.0.0.1'
const TOKEN_PATTERN = /mcpa_[A-Za-z0-9_-]+/g
const SHUTDOWN_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 20
/** Watcher cadence for the SSE test; long enough to order the seed poll first. */
const WATCH_POLL_MS = 100

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined)
  }
})

function onDispose(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup)
}

interface CapturedIo {
  readonly stdout: { write(chunk: string): unknown }
  readonly stderr: { write(chunk: string): unknown }
  outText(): string
  errText(): string
}

function captureIo(): CapturedIo {
  const out: string[] = []
  const err: string[] = []
  return {
    stdout: { write: (chunk: string) => out.push(chunk) },
    stderr: { write: (chunk: string) => err.push(chunk) },
    outText: () => out.join(''),
    errText: () => err.join(''),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

async function makeJournalDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-journal-ui-cmd-'))
  onDispose(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function tokensIn(text: string): string[] {
  return text.match(TOKEN_PATTERN) ?? []
}

interface UiFixture {
  readonly journalDir: string
  readonly io: CapturedIo
  readonly handle: UiHandle
  readonly base: string
  readonly exit: Promise<number>
  /** SIGINT listeners this run installed (empty when `signals: []`). */
  readonly installedSignalListeners: NodeJS.SignalsListener[]
  shutdown(): Promise<number>
}

interface StartUiOptions {
  readonly argv?: readonly string[]
  readonly journalDir?: string
  readonly signals?: readonly NodeJS.Signals[]
  readonly queuePollIntervalMs?: number
}

/** Boots one `ui` run on an ephemeral port against a temp journal dir. */
async function startUi(opts: StartUiOptions = {}): Promise<UiFixture> {
  const journalDir = opts.journalDir ?? (await makeJournalDir())
  const io = captureIo()
  const signals = opts.signals ?? []
  const before = new Set(process.listeners('SIGINT') as NodeJS.SignalsListener[])

  let handle: UiHandle | undefined
  const exit = runUi(['--port', '0', ...(opts.argv ?? [])], io, {
    journalDir,
    signals,
    queuePollIntervalMs: opts.queuePollIntervalMs ?? POLL_INTERVAL_MS,
    onListening: (started) => {
      handle = started
    },
  })
  exit.catch(() => undefined)
  await waitUntil(() => handle !== undefined, 'the ui server to listen')

  const started = handle as UiHandle
  const installedSignalListeners = (process.listeners('SIGINT') as NodeJS.SignalsListener[]).filter(
    (listener) => !before.has(listener),
  )

  let isShutDown = false
  const shutdown = async (): Promise<number> => {
    if (!isShutDown) {
      isShutDown = true
      await started.shutdown()
    }
    return exit
  }
  onDispose(async () => {
    await shutdown()
  })

  return {
    journalDir,
    io,
    handle: started,
    base: `http://127.0.0.1:${started.port}`,
    exit,
    installedSignalListeners,
    shutdown,
  }
}

interface HttpResponse {
  readonly status: number
  readonly body: string
  readonly headers: NodeJS.Dict<string | string[]>
}

interface RequestOptions {
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string
}

/**
 * One buffered HTTP request with `agent: false`.
 *
 * Deliberately NOT `fetch`: its pooled keep-alive sockets outlive the fixture
 * that answered them, and the ephemeral ports these fixtures bind get REUSED
 * within a run — so a later server can inherit a pooled socket belonging to an
 * already-closed one. Every request here gets its own connection, the same
 * reason `tests/ui/events-composed.test.ts` drives SSE over `node:http`.
 */
function httpCall(base: string, path: string, opts: RequestOptions = {}): Promise<HttpResponse> {
  const url = new URL(path, base)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

/** An open SSE stream plus everything it has received so far. */
interface OpenStream {
  readonly status: number
  text(): string
  close(): void
}

function openStream(base: string, path: string, headers: Record<string, string>): Promise<OpenStream> {
  const url = new URL(path, base)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        headers,
        agent: false,
      },
      (res: IncomingMessage) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          text += chunk
        })
        res.on('error', () => undefined)
        resolve({
          status: res.statusCode ?? 0,
          text: () => text,
          close: () => req.destroy(),
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

interface LoggedIn {
  readonly cookie: string
  readonly csrf: string
  readonly setCookie: string
}

/**
 * Exchanges an admin token for a session cookie + CSRF token via `/login`.
 * The login answers 303 → `/` (review M-2), so the CSRF token is read where a
 * browser reads it: the `<meta name="csrf-token">` of the page it lands on.
 */
async function loginSession(base: string, token: string): Promise<LoggedIn> {
  const response = await httpCall(base, '/login', {
    method: 'POST',
    // A browser always sends Origin on a POST, and the UI now requires it.
    headers: { 'content-type': 'application/json', origin: UI_TEST_ORIGIN },
    body: JSON.stringify({ token }),
  })
  const raw = response.headers['set-cookie']
  const setCookie = (Array.isArray(raw) ? raw[0] : raw) ?? ''
  const cookie = setCookie.split(';')[0] ?? ''
  const page = await httpCall(base, response.headers.location ?? '/', { headers: { cookie } })
  const csrf = /<meta name="csrf-token" content="([^"]*)">/.exec(page.body)?.[1] ?? ''
  return { cookie, csrf, setCookie }
}

async function login(base: string, token: string): Promise<string> {
  return (await loginSession(base, token)).cookie
}

/** POSTs a form-encoded UI action with the session's CSRF token. */
async function postAction(
  base: string,
  path: string,
  session: LoggedIn,
  fields: Record<string, string>,
): Promise<HttpResponse> {
  return httpCall(base, path, {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      'content-type': 'application/x-www-form-urlencoded',
      'x-csrf-token': session.csrf,
      origin: UI_TEST_ORIGIN,
    },
    body: new URLSearchParams(fields).toString(),
  })
}

/** Waits until an open stream has received `needle`, or the deadline passes. */
async function waitForText(stream: OpenStream, needle: string): Promise<boolean> {
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (stream.text().includes(needle)) return true
    await sleep(5)
  }
  return false
}

/**
 * Opens `/events` and reports when the server ENDS the stream — the signal an
 * out-of-process revocation is supposed to produce without waiting for the
 * 15-second heartbeat sweep.
 */
function openStreamTracked(
  base: string,
  headers: Record<string, string>,
): Promise<{ status: number; isEnded: () => boolean; close: () => void }> {
  const url = new URL('/events', base)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        headers,
        agent: false,
      },
      (res: IncomingMessage) => {
        let ended = false
        res.setEncoding('utf8')
        res.on('data', () => undefined)
        res.on('end', () => {
          ended = true
        })
        res.on('close', () => {
          ended = true
        })
        res.on('error', () => undefined)
        resolve({ status: res.statusCode ?? 0, isEnded: () => ended, close: () => req.destroy() })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** An inventory file holding exactly one quarantined tool. */
function inventoryWithQuarantinedTool(serverName: string, toolName: string): string {
  return JSON.stringify({
    version: 1,
    servers: {
      [serverName]: {
        approved: {},
        quarantined: {
          [toolName]: {
            schemaHash: 'a'.repeat(64),
            firstSeenAt: '2026-08-11T10:00:00.000Z',
            state: 'new',
            descriptor: { name: toolName, description: 'does something', inputSchema: {} },
          },
        },
      },
    },
  })
}

// ---------------------------------------------------------------------------
// Flags and startup
// ---------------------------------------------------------------------------

describe('runUi: flag parsing and startup', () => {
  test('the documented defaults are the UI constants', () => {
    expect(DEFAULT_UI_PORT).toBe(8091)
    expect(DEFAULT_UI_HOST).toBe('127.0.0.1')
    expect(UI_USAGE).toContain('mcp-journal ui')
  })

  test('an unknown flag fails with usage on stderr before anything is bound', async () => {
    const io = captureIo()
    let listened = false

    const code = await runUi(['--nope'], io, {
      journalDir: await makeJournalDir(),
      signals: [],
      onListening: () => {
        listened = true
      },
    })

    expect(code).toBe(1)
    expect(listened).toBe(false)
    expect(io.errText()).toContain('mcp-journal ui')
    expect(io.outText()).toBe('')
  })

  test('the top-level dispatcher routes `ui` here', async () => {
    const { dispatch } = await import('../../src/cli.js')
    const io = captureIo()

    const code = await dispatch(['ui', '--nope'], io, { ui: { journalDir: await makeJournalDir() } })

    expect(code).toBe(1)
    expect(io.errText()).toContain('mcp-journal ui')
    expect(io.outText()).toBe('')
  })

  test('a non-numeric --port is rejected', async () => {
    const io = captureIo()

    const code = await runUi(['--port', 'eighty'], io, {
      journalDir: await makeJournalDir(),
      signals: [],
    })

    expect(code).toBe(1)
    expect(io.errText()).toContain('--port')
    expect(io.outText()).toBe('')
  })

  test('an out-of-range --port is rejected', async () => {
    const io = captureIo()

    expect(
      await runUi(['--port', '70000'], io, { journalDir: await makeJournalDir(), signals: [] }),
    ).toBe(1)
    expect(io.errText()).toContain('--port')
  })

  test('an empty --host is rejected', async () => {
    const io = captureIo()

    expect(
      await runUi(['--host', ''], io, { journalDir: await makeJournalDir(), signals: [] }),
    ).toBe(1)
    expect(io.errText()).toContain('--host')
  })

  test('--allowed-origin null is rejected before anything is bound', async () => {
    const io = captureIo()
    let listened = false
    const code = await runUi(['--allowed-origin', 'null'], io, {
      journalDir: await makeJournalDir(),
      signals: [],
      onListening: () => {
        listened = true
      },
    })

    expect(code).toBe(1)
    expect(listened).toBe(false)
    expect(io.errText()).toContain('--allowed-origin')
    expect(io.errText().toLowerCase()).toContain('null')
  })

  test('--trusted-proxy-header requires a header name', async () => {
    const io = captureIo()

    expect(
      await runUi(['--trusted-proxy-header', ''], io, {
        journalDir: await makeJournalDir(),
        signals: [],
      }),
    ).toBe(1)
    expect(io.errText()).toContain('--trusted-proxy-header')
  })

  test('--trusted-proxy-header rejects a name that is not a valid header token', async () => {
    const io = captureIo()

    expect(
      await runUi(['--trusted-proxy-header', 'x forwarded for'], io, {
        journalDir: await makeJournalDir(),
        signals: [],
      }),
    ).toBe(1)
    expect(io.errText()).toContain('--trusted-proxy-header')
  })

  test('--trusted-proxy-header without --behind-tls warns that the header must be rewritten', async () => {
    const fixture = await startUi({ argv: ['--trusted-proxy-header', 'x-forwarded-for'] })

    // Trusting a forwarding header with nothing in front (or with a proxy that
    // passes the client's copy through) hands every caller a free-form
    // rate-limit key. The operator gets told, loudly, at startup.
    expect(fixture.io.errText()).toContain('--trusted-proxy-header')
    expect(fixture.io.outText()).toBe('')
  })

  test('a damaged state.db refuses the run before anything is bound', async () => {
    const journalDir = await makeJournalDir()
    await writeCorruptDatabase(join(journalDir, 'state.db'))

    const io = captureIo()
    let listened = false
    const code = await runUi(['--port', '0'], io, {
      journalDir,
      signals: [],
      onListening: () => {
        listened = true
      },
    })

    expect(code).toBe(1)
    expect(listened).toBe(false)
    expect(io.errText()).toContain('state.db failed PRAGMA integrity_check')
    expect(io.errText()).toContain('Refusing to start.')
    expect(io.outText()).toBe('')
  })

  test('a port already in use fails with a clear message, not a stack trace', async () => {
    const blocker = createNetServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const busyPort = (blocker.address() as AddressInfo).port
    onDispose(() => new Promise<void>((resolve) => blocker.close(() => resolve())))

    const io = captureIo()
    const code = await runUi(['--port', String(busyPort)], io, {
      journalDir: await makeJournalDir(),
      signals: [],
    })

    expect(code).toBe(1)
    expect(io.errText()).toContain(String(busyPort))
    expect(io.errText().toLowerCase()).toContain('in use')
    expect(io.errText()).not.toContain('    at ')
    expect(io.outText()).toBe('')
  })

  test('the bound address is announced on stderr and stdout stays silent', async () => {
    const fixture = await startUi()

    expect(fixture.io.errText()).toContain(`127.0.0.1:${fixture.handle.port}`)
    expect(fixture.handle.host).toBe(DEFAULT_UI_HOST)
    expect(fixture.io.outText()).toBe('')
  })

  test('a non-localhost --host produces a loud warning on stderr', async () => {
    const fixture = await startUi({ argv: ['--host', '0.0.0.0'] })

    expect(fixture.io.errText().toLowerCase()).toContain('non-localhost')
    expect(fixture.handle.host).toBe('0.0.0.0')
    expect(fixture.io.outText()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Bootstrap admin
// ---------------------------------------------------------------------------

describe('runUi: first start with no admins.json', () => {
  test('creates an owner admin and prints the bootstrap URL to stderr exactly once', async () => {
    const fixture = await startUi()

    const err = fixture.io.errText()
    const loginUrl = `http://127.0.0.1:${fixture.handle.port}/login`
    expect(err.split(loginUrl).length - 1).toBe(1)
    expect(tokensIn(err)).toHaveLength(1)
    expect(fixture.io.outText()).toBe('')

    const store = createAdminStore({ journalDir: fixture.journalDir })
    const admins = await store.listAdmins()
    expect(admins).toHaveLength(1)
    expect(admins[0]?.name).toBe(BOOTSTRAP_ADMIN_NAME)
    expect(admins[0]?.role).toBe('owner')
  })

  test('the bootstrap token works for a real login and is not on disk', async () => {
    const fixture = await startUi()
    const token = tokensIn(fixture.io.errText())[0] as string

    const cookie = await login(fixture.base, token)
    expect(cookie).toContain('=')

    const page = await httpCall(fixture.base, '/', { headers: { cookie } })
    expect(page.status).toBe(200)

    // Admin state now lives in state.db (and its -wal side file, while
    // uncheckpointed) rather than a directly-readable admins.json. Sweep
    // every persisted byte of the plane directory under two decodings so a
    // token hiding anywhere in a page -- including a partial/binary one --
    // still trips the check.
    const { fileNames, renderings } = await collectPersistedBytes(fixture.journalDir)

    // Sentinel-first: prove the sweep actually reached the state database,
    // and that what it read really is the bootstrap admin's persisted record
    // -- otherwise the absence assertions below could pass vacuously against
    // bytes that never held the store at all.
    expect(fileNames).toContain('state.db')
    const bootstrapAdmin = await createAdminStore({
      journalDir: fixture.journalDir,
    }).getActiveAdmin(BOOTSTRAP_ADMIN_NAME)
    expect(bootstrapAdmin).toBeDefined()
    expect(
      renderings.some((rendering) => rendering.includes(bootstrapAdmin?.tokenHash as string)),
    ).toBe(true)

    for (const rendering of renderings) {
      expect(rendering).not.toContain(token)
      expect(tokensIn(rendering)).toEqual([])
    }
  })

  test('no bootstrap admin is created when one already exists', async () => {
    const journalDir = await makeJournalDir()
    const store = createAdminStore({ journalDir })
    await store.createAdmin('alice', 'owner')

    const fixture = await startUi({ journalDir })

    expect(tokensIn(fixture.io.errText())).toEqual([])
    expect(fixture.io.errText()).not.toContain('/login')
    expect((await store.listAdmins()).map((admin) => admin.name)).toEqual(['alice'])
  })

  test('a corrupt admins file refuses the run instead of listening on an unusable plane', async () => {
    const journalDir = await makeJournalDir()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(journalDir, ADMINS_FILE_NAME), '{ not json', 'utf8')

    const io = captureIo()
    const code = await runUi(['--port', '0'], io, { journalDir, signals: [] })

    expect(code).toBe(1)
    expect(io.errText().length).toBeGreaterThan(0)
    expect(io.outText()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Wiring: the real page/action/SSE handlers are mounted
// ---------------------------------------------------------------------------

describe('runUi: composed handlers', () => {
  test('the login page is served and unauthenticated pages are refused', async () => {
    const fixture = await startUi()

    const loginPage = await httpCall(fixture.base, '/login')
    expect(loginPage.status).toBe(200)
    expect(loginPage.body).toContain('<form')

    // Every protected page sends an unauthenticated visitor to the login form
    // — the landing page and the rest alike, so the answer is no oracle.
    expect((await httpCall(fixture.base, '/')).status).toBe(303)
    expect((await httpCall(fixture.base, '/journal')).status).toBe(303)
    expect(fixture.io.outText()).toBe('')
  })

  test('every authenticated page an owner can reach renders', async () => {
    const fixture = await startUi()
    const token = tokensIn(fixture.io.errText())[0] as string
    const cookie = await login(fixture.base, token)

    for (const path of ['/', '/quarantine', '/servers', '/agents', '/journal', '/vault', '/admins']) {
      const response = await httpCall(fixture.base, path, { headers: { cookie } })
      expect([path, response.status]).toEqual([path, 200])
    }
    expect(fixture.io.outText()).toBe('')
  })

  test('the journal browser is wired to the real search layer, over an empty journal too', async () => {
    const fixture = await startUi()
    const token = tokensIn(fixture.io.errText())[0] as string
    const cookie = await login(fixture.base, token)

    // Three distinct read paths behind one route: session list, cross-session
    // text search, and one session's records. An empty journal dir must answer
    // all three with a page, never a 500.
    const list = await httpCall(fixture.base, '/journal', { headers: { cookie } })
    const search = await httpCall(fixture.base, '/journal?q=tools%2Fcall', { headers: { cookie } })
    const single = await httpCall(fixture.base, '/journal?session=01ABCDEF', { headers: { cookie } })

    expect([list.status, search.status, single.status]).toEqual([200, 200, 200])
    expect(search.body).toContain('<html')
    expect(fixture.io.outText()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Wiring: mutations, attribution and the live queue watcher
// ---------------------------------------------------------------------------

describe('runUi: composed stores and watcher', () => {
  test('a quarantine approval mutates the real inventory, is attributed on stderr and reaches SSE', async () => {
    const journalDir = await makeJournalDir()
    const { writeFile } = await import('node:fs/promises')
    const inventoryPath = join(journalDir, 'tool-inventory.json')
    await writeFile(inventoryPath, inventoryWithQuarantinedTool('srv', 'dangerous_tool'), 'utf8')

    const fixture = await startUi({ journalDir, queuePollIntervalMs: WATCH_POLL_MS })
    const token = tokensIn(fixture.io.errText())[0] as string
    const session = await loginSession(fixture.base, token)

    const stream = await openStream(fixture.base, '/events', { cookie: session.cookie })
    expect(stream.status).toBe(200)
    // The hub's prelude proves the stream is registered before anything changes.
    expect(await waitForText(stream, ': connected')).toBe(true)
    // The watcher SEEDS its snapshot on its first poll and deliberately never
    // replays pre-existing state (`ui/watch.ts`), so the mutation has to happen
    // after that poll for a delta to exist at all. Waiting more than one full
    // interval — a timer scheduled later than the watcher's — makes the
    // ordering deterministic instead of a race against the event loop.
    await sleep(WATCH_POLL_MS * 3)

    const response = await postAction(fixture.base, '/quarantine/approve', session, {
      server: 'srv',
      tool: 'dangerous_tool',
    })

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ status: 'ok', toolName: 'dangerous_tool' })
    // The mutation reached the real store, not a handler-local copy.
    const stored = await openInventoryStore(inventoryPath).read()
    expect(stored.servers['srv']?.quarantined).toEqual({})
    expect(Object.keys(stored.servers['srv']?.approved ?? {})).toEqual(['dangerous_tool'])
    // Attribution names the acting admin and the target, on stderr only.
    expect(fixture.io.errText()).toContain(`${BOOTSTRAP_ADMIN_NAME} quarantine.approve srv/dangerous_tool`)
    expect(fixture.io.outText()).toBe('')
    // The watcher's quarantine fingerprint changed, so subscribers were told.
    expect(await waitForText(stream, 'event: quarantine-changed')).toBe(true)

    stream.close()
  })

  test('an admin created from the UI is attributed on stderr without its token', async () => {
    const fixture = await startUi()
    const token = tokensIn(fixture.io.errText())[0] as string
    const session = await loginSession(fixture.base, token)

    const response = await postAction(fixture.base, '/admins/add', session, {
      name: 'bob',
      role: 'viewer',
    })

    expect(response.status).toBe(200)
    const errAfter = fixture.io.errText()
    expect(errAfter).toContain(`${BOOTSTRAP_ADMIN_NAME} admins.add bob`)
    // The new admin's one-time token belongs in the page, never in the log.
    expect(tokensIn(errAfter)).toHaveLength(1)
    expect(fixture.io.outText()).toBe('')

    const store = createAdminStore({ journalDir: fixture.journalDir })
    expect((await store.getActiveAdmin('bob'))?.role).toBe('viewer')
  })

  test('--behind-tls marks the session cookie Secure', async () => {
    const fixture = await startUi({ argv: ['--behind-tls'] })
    const token = tokensIn(fixture.io.errText())[0] as string

    const session = await loginSession(fixture.base, token)

    expect(session.setCookie).toContain('Secure')
  })

  test('--allowed-host admits a proxy name the bind address does not cover', async () => {
    const fixture = await startUi({ argv: ['--allowed-host', 'admin.internal'] })

    const allowed = await httpCall(fixture.base, '/login', { headers: { host: 'admin.internal' } })
    const refused = await httpCall(fixture.base, '/login', { headers: { host: 'evil.example' } })

    expect(allowed.status).toBe(200)
    expect(refused.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

describe('out-of-process revocation closes open streams well inside the heartbeat', () => {
  test('an `admin remove` from another process ends that admin SSE stream', async () => {
    const journalDir = await makeJournalDir()
    const store = createAdminStore({ journalDir })
    const { token } = await store.createAdmin('alice', 'owner')
    await store.createAdmin('bob', 'owner')
    const fixture = await startUi({ journalDir })
    const session = await loginSession(fixture.base, token)

    const stream = await openStreamTracked(fixture.base, { cookie: session.cookie })
    expect(stream.status).toBe(200)
    expect(stream.isEnded()).toBe(false)

    // A SECOND store instance stands in for the CLI process: it writes the same
    // state the running UI reads. Before this, the sweep rode the 15s heartbeat,
    // so a revoked admin could keep receiving events for that long. There is no
    // cross-process notification to subscribe to (the state is SQLite), so the
    // fix is a dedicated, faster sweep — bounded, not instantaneous.
    await createAdminStore({ journalDir }).removeAdmin('alice')

    const deadline = Date.now() + 2000
    while (!stream.isEnded() && Date.now() < deadline) await sleep(10)
    expect(stream.isEnded()).toBe(true)

    stream.close()
    await fixture.shutdown()
  })

  test('an unrelated admin keeps their stream when someone else is revoked', async () => {
    const journalDir = await makeJournalDir()
    const store = createAdminStore({ journalDir })
    const alice = await store.createAdmin('alice', 'owner')
    const bob = await store.createAdmin('bob', 'owner')
    const fixture = await startUi({ journalDir })
    const bobSession = await loginSession(fixture.base, bob.token)

    const bobStream = await openStreamTracked(fixture.base, { cookie: bobSession.cookie })
    expect(bobStream.status).toBe(200)

    await createAdminStore({ journalDir }).removeAdmin(alice.admin.name)
    await sleep(300)

    // The sweep is per-session liveness, not a blanket teardown of the hub.
    expect(bobStream.isEnded()).toBe(false)

    bobStream.close()
    await fixture.shutdown()
  })
})

describe('runUi: graceful shutdown', () => {
  test('SIGINT closes open SSE streams and the server without hanging', async () => {
    const fixture = await startUi({ signals: ['SIGINT'] })
    expect(fixture.installedSignalListeners).toHaveLength(1)

    const token = tokensIn(fixture.io.errText())[0] as string
    const cookie = await login(fixture.base, token)
    const stream = await openStream(fixture.base, '/events', { cookie })
    expect(stream.status).toBe(200)
    // The hub's prelude proves the stream is live and registered.
    expect(await waitForText(stream, ': connected')).toBe(true)

    // Drive the real signal path without signalling the test runner's process.
    ;(fixture.installedSignalListeners[0] as NodeJS.SignalsListener)('SIGINT')

    // The whole point: an open SSE connection must not keep the run alive.
    expect(await fixture.exit).toBe(0)
    stream.close()
    expect(fixture.io.errText()).toContain('SIGINT')
    expect(fixture.io.outText()).toBe('')
  })

  test('the signal handlers it installs are removed when the run ends', async () => {
    const before = process.listenerCount('SIGINT')
    const fixture = await startUi({ signals: ['SIGINT'] })
    expect(process.listenerCount('SIGINT')).toBe(before + 1)

    expect(await fixture.shutdown()).toBe(0)

    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  test('shutdown is idempotent and the port is released', async () => {
    const fixture = await startUi()
    const port = fixture.handle.port

    await fixture.handle.shutdown()
    await fixture.handle.shutdown()

    expect(await fixture.exit).toBe(0)
    await expect(httpCall(`http://127.0.0.1:${port}`, '/login')).rejects.toThrow()
  })

  test('stdout stays byte-empty across a whole run', async () => {
    const fixture = await startUi()
    const token = tokensIn(fixture.io.errText())[0] as string
    const cookie = await login(fixture.base, token)
    await httpCall(fixture.base, '/', { headers: { cookie } })

    expect(await fixture.shutdown()).toBe(0)

    expect(fixture.io.outText()).toBe('')
  })
})
