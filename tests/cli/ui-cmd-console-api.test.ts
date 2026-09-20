import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createAdminStore } from '../../src/admin/store.js'
import { runUi, type UiCommandOptions, type UiHandle } from '../../src/cli/ui-cmd.js'
import type { DispatchOptions } from '../../src/cli/dispatch-types.js'
import { CONSOLE_API_RUN_PATH, CONSOLE_API_STATE_PATH, consoleRunFrameSchema } from '../../src/console-api/contract.js'

/**
 * `mcpcut ui`'s wiring of the remote console API (ADR-0014, wave 1): when the
 * process entry point is handed a `dispatch` value, `POST /api/console/run`
 * runs a real command through it; absent, the whole `/api/console/*` prefix
 * stays unbuilt (proven in `tests/ui/console-api.test.ts` at the server
 * layer — this file only proves `ui-cmd.ts` actually wires the seam through).
 */

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined)
  }
})

function captureIo(): { stdout: { write(c: string): unknown }; stderr: { write(c: string): unknown } } {
  return { stdout: { write: () => undefined }, stderr: { write: () => undefined } }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the ui server to listen')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function startUi(options: Partial<UiCommandOptions> = {}): Promise<{ base: string; journalDir: string; shutdown(): Promise<void> }> {
  const journalDir = await mkdtemp(join(tmpdir(), 'mcpcut-ui-console-api-'))
  cleanups.push(() => rm(journalDir, { recursive: true, force: true }))
  let handle: UiHandle | undefined
  const exit = runUi(['--port', '0'], captureIo(), {
    journalDir,
    signals: [],
    onListening: (started) => {
      handle = started
    },
    ...options,
  })
  exit.catch(() => undefined)
  await waitUntil(() => handle !== undefined)
  const started = handle as UiHandle
  cleanups.push(() => started.shutdown())
  return { base: `http://127.0.0.1:${started.port}`, journalDir, shutdown: () => started.shutdown() }
}

function httpCall(
  base: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const url = new URL(path, base)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

describe('ui with a dispatch value', () => {
  test('POST /api/console/run reaches the real dispatcher and streams its output', async () => {
    let seenArgv: readonly string[] | undefined
    let seenOptions: DispatchOptions | undefined
    const dispatch = async (argv: readonly string[], io: { stdout: { write(c: string): unknown } }, opts?: DispatchOptions): Promise<number> => {
      seenArgv = argv
      seenOptions = opts
      io.stdout.write('hello from dispatch\n')
      return 0
    }

    const ui = await startUi({ dispatch })
    const adminStore = createAdminStore({ journalDir: ui.journalDir })
    const created = await adminStore.createAdmin('remote-owner', 'owner')

    const res = await httpCall(ui.base, CONSOLE_API_RUN_PATH, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ argv: ['status'] }),
    })
    const frames = res.body
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => consoleRunFrameSchema.parse(JSON.parse(line)))

    expect(res.status).toBe(200)
    expect(seenArgv).toEqual(['status'])
    expect(seenOptions?.approvals?.env).toBeDefined()
    expect(frames).toContainEqual({ t: 'out', d: 'hello from dispatch\n' })
    expect(frames.at(-1)).toEqual({ t: 'exit', code: 0 })
  })
})

describe('ui with no dispatch value', () => {
  test('the whole console API prefix is unbuilt: state answers as an unlisted route would', async () => {
    const ui = await startUi()

    const res = await httpCall(ui.base, CONSOLE_API_STATE_PATH, { headers: {} })

    // No session cookie, an unlisted route: the same 303-to-/setup or
    // 303-to-/login every other unauthenticated unlisted path gets — never
    // the console API's own public 200.
    expect(res.status).toBe(303)
  })
})
