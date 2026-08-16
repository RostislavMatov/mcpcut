import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { join } from 'node:path'
import type { AdminRole } from '../../src/admin/constants.js'
import { createAdminStore, type AdminStore } from '../../src/admin/store.js'
import { runUi, type UiHandle } from '../../src/cli/ui-cmd.js'
import { INVENTORY_FILE_NAME } from '../../src/policy/inventory.js'

/**
 * Shared harness for tests that drive the COMPOSED admin UI over a real socket
 * (M4 Task 18). It boots the production entry point — `runUi()`, the same
 * function `mcp-journal ui` runs — against a caller-owned temp journal
 * directory, so every store, the approvals queue, the tool inventory and the
 * journal are the real ones, wired the real way, and nothing touches
 * `~/.mcp-journal`.
 *
 * Three properties this harness exists to provide:
 *
 *  - **Named admins, no bootstrap.** The admins are created BEFORE the socket
 *    binds, so `runUi`'s "no admins → mint an owner and print its token to
 *    stderr" path never fires. That keeps the one legitimate token-printing
 *    path out of the marker scan below.
 *  - **A full transcript.** Every response the UI writes — status line,
 *    headers and body, including SSE bytes — is appended to one buffer, so a
 *    leak test can scan the raw bytes of an entire run rather than the handful
 *    of fields a test remembered to assert on.
 *  - **`node:http` with `agent: false`.** Like `tests/ui/events-*.test.ts`: a
 *    pooled agent keeps sockets alive past `server.close()` and turns a clean
 *    shutdown into a hang.
 *
 * `tests/ui/events-composed.test.ts` and `events-session.test.ts` deliberately
 * stay as they are: they wire `createUiServer` to STUB handlers with a fake
 * scheduler to isolate the SSE seam, which is the opposite of this harness's
 * "everything real" composition. Folding them in here would have changed what
 * they assert.
 */

/**
 * Origin a browser attaches to every POST from a page of this UI. The server
 * requires it on state-changing requests; any localhost origin is allowed, so
 * the ephemeral port need not be reflected here.
 */
const UI_TEST_ORIGIN = 'http://127.0.0.1'

/** One admin the harness mints before the UI starts listening. */
export interface AdminSpec {
  readonly name: string
  readonly role: AdminRole
}

/** The default cast: one admin per role, so a role matrix needs no setup. */
export const DEFAULT_ADMINS: readonly AdminSpec[] = Object.freeze([
  { name: 'ui-owner', role: 'owner' },
  { name: 'ui-operator', role: 'operator' },
  { name: 'ui-viewer', role: 'viewer' },
])

export interface StartUiOptions {
  /** Temp journal directory holding every store this UI reads and writes. */
  readonly journalDir: string
  readonly admins?: readonly AdminSpec[]
  /** Watcher cadence; tests keep it small so an SSE delta lands in milliseconds. */
  readonly queuePollIntervalMs?: number
  readonly approvalsBaseDir?: string
  readonly inventoryStorePath?: string
}

/** One buffered HTTP exchange, as the harness records it. */
export interface UiResponse {
  readonly status: number
  readonly headers: NodeJS.Dict<string | string[]>
  readonly body: string
}

/** A logged-in browser: one cookie, one CSRF token, real requests. */
export interface UiClient {
  readonly adminName: string
  readonly cookie: string
  readonly csrfToken: string
  get(path: string): Promise<UiResponse>
  /** POSTs `application/x-www-form-urlencoded` with the session's CSRF token. */
  post(path: string, fields?: Readonly<Record<string, string>>): Promise<UiResponse>
  /** POSTs without the CSRF token, for the negative case. */
  postWithoutCsrf(path: string, fields?: Readonly<Record<string, string>>): Promise<UiResponse>
}

/** A live `GET /events` subscription. */
export interface SseStream {
  /** Everything received so far. */
  text(): string
  /** Resolves once an `event: <name>` line has arrived (or rejects on timeout). */
  waitFor(name: string, timeoutMs?: number): Promise<void>
  close(): void
}

export interface UiTestHarness {
  readonly port: number
  readonly base: string
  readonly adminStore: AdminStore
  /** One-time tokens by admin name, as `createAdmin` returned them. */
  readonly tokens: Readonly<Record<string, string>>
  /** Everything `runUi` wrote to its stderr sink. */
  stderr(): string
  /** Every response byte the UI has produced this run (headers + bodies + SSE). */
  transcript(): string
  login(adminName: string): Promise<UiClient>
  openSse(client: UiClient): Promise<SseStream>
  /** Graceful shutdown; resolves with `runUi`'s exit code. Idempotent. */
  stop(): Promise<number>
}

const SSE_WAIT_TIMEOUT_MS = 5000
const SSE_WAIT_POLL_MS = 20

/** `content="..."` of the layout's CSRF meta tag, or `''` when absent. */
export function csrfTokenOf(html: string): string {
  return /<meta name="csrf-token" content="([^"]*)"/.exec(html)?.[1] ?? ''
}

function encodeForm(fields: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) params.append(key, value)
  return params.toString()
}

export async function startUiHarness(opts: StartUiOptions): Promise<UiTestHarness> {
  const journalDir = opts.journalDir
  const adminStore = createAdminStore({ journalDir })
  const tokens: Record<string, string> = {}
  for (const spec of opts.admins ?? DEFAULT_ADMINS) {
    tokens[spec.name] = (await adminStore.createAdmin(spec.name, spec.role)).token
  }

  const errChunks: string[] = []
  const outChunks: string[] = []
  const transcriptChunks: string[] = []
  const openRequests = new Set<ClientRequest>()

  let handle: UiHandle | undefined
  const finished = runUi(
    ['--port', '0'],
    {
      stdout: { write: (chunk: string) => outChunks.push(chunk) },
      stderr: { write: (chunk: string) => errChunks.push(chunk) },
    },
    {
      journalDir,
      approvalsBaseDir: opts.approvalsBaseDir ?? join(journalDir, 'approvals'),
      inventoryStorePath: opts.inventoryStorePath ?? join(journalDir, INVENTORY_FILE_NAME),
      signals: [],
      ...(opts.queuePollIntervalMs !== undefined
        ? { queuePollIntervalMs: opts.queuePollIntervalMs }
        : {}),
      onListening: (started) => {
        handle = started
      },
    },
  )
  finished.catch(() => undefined)
  await waitForHandle(() => handle)
  const bound = handle as UiHandle
  const base = `http://127.0.0.1:${bound.port}`

  function record(what: string): void {
    transcriptChunks.push(what)
  }

  function send(
    method: 'GET' | 'POST',
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<UiResponse> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: bound.port,
          path,
          method,
          headers: body === undefined
            ? headers
            : { ...headers, 'content-length': String(Buffer.byteLength(body)) },
          // A pooled agent outlives `server.close()` and hangs the shutdown.
          agent: false,
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            record(`${res.statusCode ?? 0} ${JSON.stringify(res.headers)}\n${text}`)
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text })
          })
        },
      )
      openRequests.add(req)
      req.on('close', () => openRequests.delete(req))
      req.on('error', reject)
      if (body !== undefined) req.write(body)
      req.end()
    })
  }

  async function login(adminName: string): Promise<UiClient> {
    const token = tokens[adminName]
    if (token === undefined) throw new Error(`no admin token for "${adminName}"`)
    const loggedIn = await send(
      'POST',
      '/login',
      { 'content-type': 'application/json', origin: UI_TEST_ORIGIN },
      JSON.stringify({ token }),
    )
    if (loggedIn.status !== 303) {
      throw new Error(`login for "${adminName}" answered ${loggedIn.status}, expected 303`)
    }
    const rawCookie = loggedIn.headers['set-cookie']
    const cookie = (Array.isArray(rawCookie) ? rawCookie[0] : rawCookie ?? '').split(';')[0] ?? ''
    // The CSRF token travels in the landing page's meta tag, never in the 303.
    const landing = await send('GET', '/', { cookie })
    const csrfToken = csrfTokenOf(landing.body)
    if (csrfToken === '') throw new Error(`no csrf-token meta on the landing page for "${adminName}"`)

    const postWith = (
      path: string,
      fields: Readonly<Record<string, string>>,
      withCsrf: boolean,
    ): Promise<UiResponse> =>
      send(
        'POST',
        path,
        { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: UI_TEST_ORIGIN },
        encodeForm(withCsrf ? { csrf_token: csrfToken, ...fields } : fields),
      )

    return {
      adminName,
      cookie,
      csrfToken,
      get: (path) => send('GET', path, { cookie }),
      post: (path, fields = {}) => postWith(path, fields, true),
      postWithoutCsrf: (path, fields = {}) => postWith(path, fields, false),
    }
  }

  function openSse(client: UiClient): Promise<SseStream> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: bound.port,
          path: '/events',
          method: 'GET',
          headers: { cookie: client.cookie },
          agent: false,
        },
        (res: IncomingMessage) => {
          let received = ''
          record(`${res.statusCode ?? 0} ${JSON.stringify(res.headers)}\n`)
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            received += chunk
            record(chunk)
          })
          resolve({
            text: () => received,
            waitFor: (name, timeoutMs = SSE_WAIT_TIMEOUT_MS) =>
              waitUntilText(() => received, `event: ${name}`, timeoutMs),
            close: () => req.destroy(),
          })
        },
      )
      openRequests.add(req)
      req.on('close', () => openRequests.delete(req))
      req.on('error', reject)
      req.end()
    })
  }

  let stopped: Promise<number> | null = null
  function stop(): Promise<number> {
    stopped ??= (async () => {
      for (const req of [...openRequests]) req.destroy()
      openRequests.clear()
      await bound.shutdown()
      return finished
    })()
    return stopped
  }

  return {
    port: bound.port,
    base,
    adminStore,
    tokens,
    stderr: () => errChunks.join(''),
    transcript: () => transcriptChunks.join('\n'),
    login,
    openSse,
    stop,
  }
}

/** Polls until `runUi` reports the socket is bound. */
async function waitForHandle(read: () => UiHandle | undefined): Promise<void> {
  const deadline = Date.now() + SSE_WAIT_TIMEOUT_MS
  while (read() === undefined) {
    if (Date.now() > deadline) throw new Error('ui harness: the server never reported listening')
    await new Promise((resolve) => setTimeout(resolve, SSE_WAIT_POLL_MS))
  }
}

/** Polls an accumulating buffer until it contains `needle`. */
async function waitUntilText(read: () => string, needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!read().includes(needle)) {
    if (Date.now() > deadline) {
      throw new Error(`ui harness: timed out waiting for "${needle}"`)
    }
    await new Promise((resolve) => setTimeout(resolve, SSE_WAIT_POLL_MS))
  }
}
