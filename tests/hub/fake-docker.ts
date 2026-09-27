import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  connectNetwork,
  createContainer,
  createExec,
  createNetwork,
  createStore,
  createVolume,
  disconnectNetwork,
  inspectContainer,
  inspectExec,
  inspectNetwork,
  inspectVolume,
  listContainers,
  removeContainer,
  removeNetwork,
  removeVolume,
  setRunning,
  systemDf,
  type FakeContainer,
  type FakeNetwork,
  type FakeStore,
  type FakeVolume,
  type Reply,
} from './fake-docker-state.js'

/**
 * A fake Docker Engine on a unix socket (plan `tenant-orchestrator`, Task 3):
 * the endpoints the provisioner's client uses, over in-memory state, with
 * the daemon's status codes. A test passing against it should say something
 * about the real daemon, so it is strict where Docker is: a versioned path,
 * `Content-Type: application/json` on every body, `?name=` on create.
 *
 * `POST /exec/{id}/start` answers the way moby does for a request without
 * `Upgrade`: it takes the connection over and writes a bare
 * `HTTP/1.1 200 OK` head (no length, no chunking), then the multiplexed
 * frames, then closes — the body is delimited by the close. The frames can
 * be cut into chunks of any size to exercise the client's demultiplexer.
 *
 * The socket lives in a fresh directory under `os.tmpdir()`; macOS caps a
 * unix socket path at 104 bytes, so the path is checked against 100.
 */

export const FAKE_API_VERSION = 'v1.45'
const MAX_SOCKET_PATH = 100
const HEADER_BYTES = 8
const CHUNK_PAUSE_MS = 1

export interface ExecScript {
  readonly exitCode: number
  readonly stdout?: string | Buffer
  readonly stderr?: string | Buffer
  /** Payload bytes per frame (default: one frame per stream). */
  readonly frameSize?: number
  /** Bytes per socket write (default: everything in one write). */
  readonly chunkSize?: number
  /** Replaces the framed output with these bytes verbatim. */
  readonly rawStream?: Buffer
  /** Inspections of the exec that still answer `Running: true` after the stream ends. */
  readonly runningInspections?: number
}

export interface ExecCall {
  readonly user: string | undefined
  readonly env: readonly string[]
}

export type ExecHandler = (container: FakeContainer, argv: readonly string[], call: ExecCall) => ExecScript

export interface FakeDockerCall {
  readonly method: string
  /** The route template, e.g. `POST /containers/{id}/start`. */
  readonly route: string
  /** The path without the version prefix, e.g. `/containers/abc/start`. */
  readonly path: string
  readonly version: string
  readonly query: Readonly<Record<string, string>>
  readonly contentType: string | undefined
  readonly body: unknown
}

export interface CannedReply {
  readonly status: number
  readonly body: string | Buffer
  readonly contentType?: string
  /** Sends the body chunked, without `Content-Length`, so only the read cap can stop it. */
  readonly omitLength?: boolean
}

export interface FakeDocker {
  readonly socketPath: string
  onExec(handler: ExecHandler): void
  /** The next request on `route` answers `status` with Docker's `{message}` body; state is untouched. */
  failNext(route: string, status: number, message?: string): void
  /** The next request on `route` answers these exact bytes. */
  replyNext(route: string, reply: CannedReply): void
  /** The next request on `route` never answers (until `close`). */
  hangNext(route: string): void
  calls(): readonly FakeDockerCall[]
  networks(): readonly FakeNetwork[]
  volumes(): readonly FakeVolume[]
  containers(): readonly FakeContainer[]
  setVolumeSize(name: string, bytes: number): void
  close(): Promise<void>
}

type Action =
  | { readonly kind: 'fail'; readonly status: number; readonly message: string }
  | { readonly kind: 'reply'; readonly reply: CannedReply }
  | { readonly kind: 'hang' }

interface Route {
  readonly method: string
  readonly pattern: RegExp
  readonly template: string
  readonly handle: (ctx: RouteContext) => Reply | 'stream'
}

interface RouteContext {
  readonly store: FakeStore
  readonly param: string
  readonly query: URLSearchParams
  readonly body: unknown
}

const route = (method: string, pattern: RegExp, path: string, handle: Route['handle']): Route => ({
  method,
  pattern,
  template: `${method} ${path}`,
  handle,
})

const ROUTES: readonly Route[] = [
  route('POST', /^\/networks\/create$/, '/networks/create', (c) => createNetwork(c.store, c.body)),
  route('POST', /^\/networks\/([^/]+)\/connect$/, '/networks/{id}/connect', (c) => connectNetwork(c.store, c.param, c.body)),
  route('POST', /^\/networks\/([^/]+)\/disconnect$/, '/networks/{id}/disconnect', (c) => disconnectNetwork(c.store, c.param, c.body)),
  route('GET', /^\/networks\/([^/]+)$/, '/networks/{id}', (c) => inspectNetwork(c.store, c.param)),
  route('DELETE', /^\/networks\/([^/]+)$/, '/networks/{id}', (c) => removeNetwork(c.store, c.param)),
  route('POST', /^\/volumes\/create$/, '/volumes/create', (c) => createVolume(c.store, c.body)),
  route('GET', /^\/volumes\/([^/]+)$/, '/volumes/{name}', (c) => inspectVolume(c.store, c.param)),
  route('DELETE', /^\/volumes\/([^/]+)$/, '/volumes/{name}', (c) => removeVolume(c.store, c.param)),
  route('GET', /^\/system\/df$/, '/system/df', (c) => systemDf(c.store)),
  route('POST', /^\/containers\/create$/, '/containers/create', (c) => createContainer(c.store, c.query.get('name'), c.body)),
  route('GET', /^\/containers\/json$/, '/containers/json', (c) => listContainers(c.store, c.query)),
  route('POST', /^\/containers\/([^/]+)\/start$/, '/containers/{id}/start', (c) => setRunning(c.store, c.param, true)),
  route('POST', /^\/containers\/([^/]+)\/stop$/, '/containers/{id}/stop', (c) => setRunning(c.store, c.param, false)),
  route('DELETE', /^\/containers\/([^/]+)$/, '/containers/{id}', (c) =>
    removeContainer(c.store, c.param, c.query.get('force') === 'true' || c.query.get('force') === '1'),
  ),
  route('GET', /^\/containers\/([^/]+)\/json$/, '/containers/{id}/json', (c) => inspectContainer(c.store, c.param)),
  route('POST', /^\/containers\/([^/]+)\/exec$/, '/containers/{id}/exec', (c) => createExec(c.store, c.param, c.body)),
  route('POST', /^\/exec\/([^/]+)\/start$/, '/exec/{id}/start', () => 'stream'),
  route('GET', /^\/exec\/([^/]+)\/json$/, '/exec/{id}/json', (c) => inspectExec(c.store, c.param)),
]

const VERSIONED_PATH = /^\/(v\d+\.\d+)(\/.*)$/

function frame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt8(type, 0)
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

function framesOf(type: number, payload: string | Buffer | undefined, frameSize: number | undefined): Buffer[] {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : (payload ?? Buffer.alloc(0))
  if (data.length === 0) return []
  const size = frameSize ?? data.length
  const out: Buffer[] = []
  for (let offset = 0; offset < data.length; offset += size) out.push(frame(type, data.subarray(offset, offset + size)))
  return out
}

function chunksOf(buffer: Buffer, size: number | undefined): Buffer[] {
  const step = size ?? Math.max(buffer.length, 1)
  const out: Buffer[] = []
  for (let offset = 0; offset < buffer.length; offset += step) out.push(buffer.subarray(offset, offset + step))
  return out
}

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, CHUNK_PAUSE_MS))

function sendReply(res: ServerResponse, reply: Reply): void {
  if (reply.body === undefined) {
    res.writeHead(reply.status).end()
    return
  }
  const payload = JSON.stringify(reply.body)
  res.writeHead(reply.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }).end(payload)
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function socketDirectory(): { dir: string; socketPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fdk-'))
  const socketPath = join(dir, 'd.sock')
  if (socketPath.length > MAX_SOCKET_PATH) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`fake-docker: socket path is ${socketPath.length} bytes, over ${MAX_SOCKET_PATH} (set a shorter TMPDIR)`)
  }
  return { dir, socketPath }
}

/** What the request handlers share: the state, the call log and the scripted behaviour. */
interface FakeRuntime {
  readonly store: FakeStore
  readonly log: FakeDockerCall[]
  takeAction(template: string): Action | undefined
  execHandler(): ExecHandler
}

async function streamExec(runtime: FakeRuntime, res: ServerResponse, execId: string): Promise<void> {
  const { store } = runtime
  const exec = store.execs.get(execId)
  if (exec === undefined) return sendReply(res, { status: 404, body: { message: `No such exec instance: ${execId}` } })
  if (exec.started) return sendReply(res, { status: 409, body: { message: `exec ${execId} has already been started` } })
  const container = store.containers.get(exec.containerId)
  if (container === undefined) return sendReply(res, { status: 404, body: { message: 'No such container' } })
  store.execs.set(execId, { ...exec, started: true })
  const script = runtime.execHandler()(container, exec.argv, { user: exec.user, env: exec.env })
  const bytes =
    script.rawStream ?? Buffer.concat([...framesOf(1, script.stdout, script.frameSize), ...framesOf(2, script.stderr, script.frameSize)])
  // moby's hijack path for a request without `Upgrade`: a bare head, then raw bytes until close.
  const socket = res.socket
  if (socket === null) return
  socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n')
  for (const chunk of chunksOf(bytes, script.chunkSize)) {
    socket.write(chunk)
    await pause()
  }
  store.execs.set(execId, { ...exec, started: true, exitCode: script.exitCode, runningInspections: script.runningInspections ?? 0 })
  socket.end()
}

interface ParsedRequest {
  readonly route: Route
  readonly param: string
  readonly url: URL
  readonly call: FakeDockerCall
}

/** The matched route and the logged call, or the error reply Docker would give. */
async function parseRequest(req: IncomingMessage): Promise<ParsedRequest | Reply> {
  const url = new URL(req.url ?? '/', 'http://docker')
  const versioned = VERSIONED_PATH.exec(url.pathname)
  if (versioned === null) return { status: 400, body: { message: 'the fake requires a versioned path' } }
  const version = versioned[1] as string
  const path = versioned[2] as string
  const matched = ROUTES.find((candidate) => candidate.method === req.method && candidate.pattern.test(path))
  if (matched === undefined) return { status: 404, body: { message: 'page not found' } }
  const raw = await readRequestBody(req)
  const contentType = req.headers['content-type']
  if (raw.length > 0 && contentType !== 'application/json') {
    return { status: 400, body: { message: `unsupported Content-Type header (${String(contentType)}): must be 'application/json'` } }
  }
  const body: unknown = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : undefined
  const query = Object.fromEntries(url.searchParams)
  const call = { method: req.method ?? '', route: matched.template, path, version, query, contentType, body }
  return { route: matched, param: decodeURIComponent(matched.pattern.exec(path)?.[1] ?? ''), url, call }
}

async function handleRequest(runtime: FakeRuntime, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = await parseRequest(req)
  if (!('route' in parsed)) return sendReply(res, parsed)
  runtime.log.push(parsed.call)
  const action = runtime.takeAction(parsed.route.template)
  if (action?.kind === 'hang') return
  if (action?.kind === 'fail') return sendReply(res, { status: action.status, body: { message: action.message } })
  if (action?.kind === 'reply') {
    const { reply } = action
    const length = reply.omitLength === true ? {} : { 'content-length': Buffer.byteLength(reply.body) }
    res.writeHead(reply.status, { 'content-type': reply.contentType ?? 'application/json', ...length }).end(reply.body)
    return
  }
  const outcome = parsed.route.handle({ store: runtime.store, param: parsed.param, query: parsed.url.searchParams, body: parsed.call.body })
  if (outcome === 'stream') return streamExec(runtime, res, parsed.param)
  sendReply(res, outcome)
}

export async function startFakeDocker(): Promise<FakeDocker> {
  const { dir, socketPath } = socketDirectory()
  const store = createStore()
  const log: FakeDockerCall[] = []
  const pending = new Map<string, readonly Action[]>()
  let execHandler: ExecHandler = () => ({ exitCode: 0 })
  const runtime: FakeRuntime = {
    store,
    log,
    takeAction: (template) => {
      const [action, ...rest] = pending.get(template) ?? []
      if (rest.length === 0) pending.delete(template)
      else pending.set(template, rest)
      return action
    },
    execHandler: () => execHandler,
  }
  const enqueue = (template: string, action: Action): void => {
    pending.set(template, [...(pending.get(template) ?? []), action])
  }
  const server = createServer((req, res) => {
    handleRequest(runtime, req, res).catch(() => {
      if (!res.headersSent) sendReply(res, { status: 400, body: { message: 'bad request' } })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => resolve())
  })
  return {
    socketPath,
    onExec: (handler) => {
      execHandler = handler
    },
    failNext: (template, status, message = 'fake failure') => enqueue(template, { kind: 'fail', status, message }),
    replyNext: (template, reply) => enqueue(template, { kind: 'reply', reply }),
    hangNext: (template) => enqueue(template, { kind: 'hang' }),
    calls: () => [...log],
    networks: () => [...store.networks.values()],
    volumes: () => [...store.volumes.values()],
    containers: () => [...store.containers.values()],
    setVolumeSize: (name, bytes) => {
      const volume = store.volumes.get(name)
      if (volume === undefined) throw new Error(`fake-docker: no volume ${name}`)
      store.volumes.set(name, { ...volume, sizeBytes: bytes })
    },
    close: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export type { FakeContainer, FakeNetwork, FakeVolume }
