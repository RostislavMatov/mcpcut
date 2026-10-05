import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { FILES_PG_URL_SECRET } from '../../../src/files/db/constants.js'
import { loadPg } from '../../../src/files/db/pg-loader.js'
import type { PgModule } from '../../../src/files/db/pg-types.js'
import type { FileRule } from '../../../src/files/rights.js'
import { CLOSING_PROBLEM, createSearchBackend, type SearchBackend, type SearchBackendOptions } from '../../../src/files/search/search-backend.js'
import { createFilesServer } from '../../../src/files/server.js'
import { createVaultStore } from '../../../src/vault/store.js'
import { createFakeEmbedder, type FakeEmbedder } from './fake-embedder.js'
import { createSearchFixture, type SearchFixture } from './search-fixture.js'
import { describePg } from '../db/pg-helpers.js'

/** Closing while a call is in `open()` or a search runs, probe caching, and what the agent and the administrator are told. */

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}
function startedSignal(): { started: Promise<void>; signal: () => void } {
  const gate = deferred<void>()
  return { started: gate.promise, signal: () => gate.resolve() }
}

let fx: SearchFixture
const backends: SearchBackend[] = []
beforeEach(async () => {
  fx = await createSearchFixture()
})
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.close()))
  await fx.cleanup()
})

function backendOver(extra: Partial<SearchBackendOptions> = {}): SearchBackend {
  const backend = createSearchBackend({
    journalDir: fx.journalDir,
    cli: 'mcpcut',
    schema: fx.schema,
    loadPg: () => loadPg(process.cwd()),
    createEmbedder: async () => fx.embedder,
    ...extra,
  })
  backends.push(backend)
  return backend
}

/** The real pg module, counting the pools it made and ended. */
function countingPg(): { load: () => Promise<PgModule>; made: () => number; ended: () => number } {
  let made = 0
  let ended = 0
  return {
    load: async () => {
      const real = await loadPg(process.cwd())
      return {
        Pool: class extends real.Pool {
          constructor(config: ConstructorParameters<PgModule['Pool']>[0]) {
            super(config)
            made += 1
          }
          override async end(): Promise<void> {
            ended += 1
            await super.end()
          }
        },
      }
    },
    made: () => made,
    ended: () => ended,
  }
}

describePg('closing while open() is in flight', () => {
  test('an embedder that finishes after close is closed, and the call says the server is closing', async () => {
    const made = deferred<FakeEmbedder>()
    const started = deferred<void>()
    const backend = backendOver({ createEmbedder: () => (started.resolve(), made.promise) })
    const opening = backend.open()
    await started.promise

    const closing = backend.close()
    made.resolve(fx.embedder)
    await closing

    expect(await opening).toEqual({ kind: 'unavailable', problem: CLOSING_PROBLEM, isClosing: true })
    expect(fx.embedder.isClosed()).toBe(true)
  })

  test('no embedder is built when close arrives between the probe and the model', async () => {
    const probeGate = deferred<void>()
    let embedders = 0
    const probing = deferred<void>()
    const backend = backendOver({
      createEmbedder: async () => (embedders += 1, fx.embedder),
      probe: async (db) => {
        probing.resolve()
        await probeGate.promise
        return { kind: 'ready', sdb: { db, vectorSchema: 'public' } }
      },
    })
    const opening = backend.open()
    await probing.promise

    await backend.close()
    probeGate.resolve()

    expect(await opening).toMatchObject({ kind: 'unavailable', isClosing: true })
    expect(embedders).toBe(0)
  })

  test('a pool that finishes opening after close is ended at once', async () => {
    const pg = countingPg()
    const loaded = deferred<void>()
    const started = deferred<void>()
    const backend = backendOver({ loadPg: async () => (started.resolve(), await loaded.promise, pg.load()) })
    const opening = backend.open()
    await started.promise

    const closing = backend.close()
    loaded.resolve()
    await closing

    expect(await opening).toMatchObject({ kind: 'unavailable', isClosing: true })
    expect([pg.made(), pg.ended()]).toEqual([1, 1])
  })
})

describePg('a search running when the file server closes', () => {
  test('an error that arrives after close is the closing line, not a fault, and nothing is reported', async () => {
    const reports: string[] = []
    const search = backendOver({ onProblem: (problem) => reports.push(problem) })
    await fx.put({ 'A/a.md': 'refund returns' })
    await fx.index([fx.dir('A')])
    const embedding = { ...deferred<Float32Array>(), ...startedSignal() }
    const slow = { ...fx.embedder, embedQuery: () => (embedding.signal(), embedding.promise) }
    const rules: FileRule[] = [{ path: fx.dir('A'), ops: ['read'] }]
    const server = createFilesServer({
      roots: async () => [fx.dir('A')],
      rules: async () => rules,
      actor: 'a',
      searchListed: async () => true,
      search: { ...search, open: async () => ({ kind: 'ready' as const, sdb: fx.sdb, embedder: slow }) },
    })
    const calling = server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_files', arguments: { query: 'refund' } } })
    await embedding.started

    await search.close()
    embedding.reject(new Error('Connection terminated'))

    const text = ((await calling) as { result: { content: Array<{ text: string }> } }).result.content[0]?.text
    expect(text).toBe(CLOSING_PROBLEM)
    expect(reports).toEqual([])
  })
})

describePg('the probe is cached for a short time', () => {
  test('a good probe is reused for 30 seconds and asked again after', async () => {
    let probes = 0
    let nowMs = 1_000_000
    const backend = backendOver({
      now: () => nowMs,
      probe: async (db) => (probes += 1, { kind: 'ready', sdb: { db, vectorSchema: 'public' } }),
    })

    await backend.open()
    nowMs += 29_999
    await backend.open()
    nowMs += 2
    await backend.open()

    expect(probes).toBe(2)
  })

  test('an empty or failed probe is asked again every time', async () => {
    let probes = 0
    const answers = [{ kind: 'empty' as const }, { kind: 'unavailable' as const, problem: 'x' }]
    const backend = backendOver({ probe: async () => (probes += 1, answers[probes - 1] ?? { kind: 'empty' as const }) })

    await backend.open()
    await backend.open()
    await backend.open()

    expect(probes).toBe(3)
  })
})

describePg('what the agent and the administrator are told', () => {
  test('a repeated problem reaches the administrator once; a different one reaches it too', async () => {
    const reports: string[] = []
    let failure = 'boom one'
    const backend = backendOver({ onProblem: (problem) => reports.push(problem), createEmbedder: async () => Promise.reject(new Error(failure)) })

    await backend.open()
    await backend.open()
    failure = 'boom two'
    await backend.open()

    expect(reports).toEqual(['boom one', 'boom two'])
  })

  test('an unreachable Postgres with a password in its URL: the agent gets the fixed line, the log never the password', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcpcut-leak-'))
    try {
      await createVaultStore({ journalDir: dir }).init()
      await createVaultStore({ journalDir: dir }).setSecret(FILES_PG_URL_SECRET, 'postgres://leakuser:s3cretpw@127.0.0.1:1/leakdb')
      const reports: string[] = []
      const search = createSearchBackend({ journalDir: dir, cli: 'mcpcut', loadPg: () => loadPg(process.cwd()), onProblem: (problem) => reports.push(problem) })
      backends.push(search)
      const server = createFilesServer({
        roots: async () => [fx.dir('A')],
        rules: async () => [{ path: fx.dir('A'), ops: ['read'] as const }],
        actor: 'a',
        searchListed: async () => true,
        search,
      })

      const response = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_files', arguments: { query: 'x' } } })) as {
        result: { content: Array<{ text: string }>; isError?: boolean }
      }

      const text = response.result.content[0]?.text
      expect(text).toBe('Search by meaning is not available right now: ask an administrator to run `mcpcut files db status`.')
      expect(response.result.isError).toBe(true)
      expect(reports.length).toBe(1)
      expect(reports.join('\n')).not.toContain('s3cretpw')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('the embedder of a fixture is a plain fake (guards the tests above)', () => {
  expect(createFakeEmbedder().isClosed()).toBe(false)
})
