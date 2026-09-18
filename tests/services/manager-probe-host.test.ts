import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { JOURNAL_DIR_MODE, JOURNAL_FILE_MODE } from '../../src/config.js'
import { PID_RECORD_VERSION, type ServiceName } from '../../src/services/constants.js'
import { createServiceManager, type ServiceManagerDeps } from '../../src/services/manager.js'
import { probeTargetOf } from '../../src/services/manager-types.js'
import { pidFilePathFor, runDirFor } from '../../src/services/paths.js'
import type { PidRecord } from '../../src/services/pid-file.js'
import type { probeService } from '../../src/services/probe.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfig } from '../../src/setup/schema.js'

/**
 * `probeHost` (Q32): the address `status` dials for a service it has no pid
 * file for. Inside compose `0.0.0.0` rewritten to loopback reaches only the
 * container's own netns, so the neighbour read `stopped` while it was healthy;
 * the config names the neighbour instead. The bind (`host`/`port` of the
 * status) is untouched, and a pid record keeps its own address — mcpcut
 * started that process there and an edited config must not move the probe.
 *
 * Its own file rather than more of `manager.test.ts`, which is past the size
 * the project allows; the helpers it needs are small enough to restate.
 */

/** Documentation range (RFC 5737): routable on paper, never answering in a test. */
const UNREACHABLE_HOST = '192.0.2.1'

const cleanups: Array<() => Promise<void>> = []
let dataDir: string
let config: InstallConfig

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined)
  }
})

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mcpcut-probe-host-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  config = defaultInstallConfig(dataDir)
})

/** A port nothing holds: bind an ephemeral one, learn its number, give it back. */
async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** An HTTP server answering `/login` on loopback, standing in for the neighbour container. */
async function startForeignUi(): Promise<number> {
  const server = createHttpServer((req, res) => {
    res.writeHead(req.url === '/login' ? 200 : 404)
    res.end()
  })
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return (server.address() as AddressInfo).port
}

/** A probe that answers from a list and remembers every address it was asked to dial. */
function recordingProbe(answering: readonly string[]): {
  readonly probe: typeof probeService
  readonly dialled: Array<{ service: ServiceName; host: string; port: number }>
} {
  const dialled: Array<{ service: ServiceName; host: string; port: number }> = []
  const probe: typeof probeService = async (service, host, port) => {
    dialled.push({ service, host, port })
    return answering.includes(host)
  }
  return { probe, dialled }
}

function statusOf(service: ServiceName, overrides: Partial<ServiceManagerDeps> = {}) {
  return createServiceManager({ dataDir, config, ...overrides }).status(service)
}

describe('probeTargetOf', () => {
  test('is the bind when no probeHost is configured', () => {
    expect(probeTargetOf(config, 'serve')).toEqual({ host: config.serve.host, port: config.serve.port })
  })

  test('dials probeHost on the bind port when one is configured', () => {
    const withProbe: InstallConfig = { ...config, ui: { ...config.ui, host: '0.0.0.0', probeHost: 'ui' } }

    expect(probeTargetOf(withProbe, 'ui')).toEqual({ host: 'ui', port: config.ui.port })
  })
})

describe('status without a pid file dials probeHost (Q32)', () => {
  test('under an external supervisor the neighbour answering on probeHost is external, named by that address', async () => {
    const port = await startForeignUi()
    config = {
      ...config,
      supervisor: 'external',
      ui: { ...config.ui, host: UNREACHABLE_HOST, port, probeHost: '127.0.0.1' },
    }

    const status = await statusOf('ui')

    expect(status.state).toBe('external')
    expect(status.detail).toBe(
      `answering on 127.0.0.1:${port}; managed by an external supervisor (supervisor: external), mcpcut only reports`,
    )
    // The status still reports the bind: the header and the exposure warning speak about it.
    expect(status.host).toBe(UNREACHABLE_HOST)
    expect(status.port).toBe(port)
  })

  test('without probeHost the same install dials the bind and reads stopped', async () => {
    config = { ...config, supervisor: 'external', serve: { ...config.serve, host: UNREACHABLE_HOST } }
    const { probe, dialled } = recordingProbe(['127.0.0.1'])

    const status = await statusOf('serve', { probe })

    expect(status.state).toBe('stopped')
    expect(dialled).toEqual([{ service: 'serve', host: UNREACHABLE_HOST, port: config.serve.port }])
    expect(status.detail).toBe(
      `not answering on ${UNREACHABLE_HOST}:${config.serve.port}; managed by an external supervisor ` +
        '(supervisor: external) — check compose or systemd',
    )
  })

  test('a silent probeHost is named in the detail, not the bind', async () => {
    config = {
      ...config,
      supervisor: 'external',
      serve: { ...config.serve, host: '0.0.0.0', probeHost: 'serve' },
    }
    const { probe } = recordingProbe([])

    const status = await statusOf('serve', { probe })

    expect(status.state).toBe('stopped')
    expect(status.host).toBe('0.0.0.0')
    expect(status.detail).toBe(
      `not answering on serve:${config.serve.port}; managed by an external supervisor ` +
        '(supervisor: external) — check compose or systemd',
    )
  })

  test('under mcpcut\'s own supervisor a pid-less status dials probeHost as well', async () => {
    config = { ...config, ui: { ...config.ui, probeHost: 'plane-ui' } }
    const { probe, dialled } = recordingProbe(['plane-ui'])

    const status = await statusOf('ui', { probe })

    expect(status.state).toBe('external')
    expect(dialled).toEqual([{ service: 'ui', host: 'plane-ui', port: config.ui.port }])
    expect(status.detail).toBe(`something answers on plane-ui:${config.ui.port} but mcpcut has no pid file for it`)
  })

  test('a probeHost that does not resolve reads stopped rather than throwing', async () => {
    config = {
      ...config,
      supervisor: 'external',
      serve: { ...config.serve, port: await freePort(), probeHost: 'no-such-service.invalid' },
    }

    const status = await statusOf('serve')

    expect(status.state).toBe('stopped')
  })
})

describe('a pid record ignores probeHost', () => {
  test('the probe dials the record\'s address, as the rule for an edited config requires', async () => {
    config = { ...config, serve: { ...config.serve, probeHost: 'somewhere-else' } }
    mkdirSync(runDirFor(dataDir), { recursive: true, mode: JOURNAL_DIR_MODE })
    const record: PidRecord = {
      version: PID_RECORD_VERSION,
      service: 'serve',
      pid: process.pid,
      host: '127.0.0.1',
      port: config.serve.port,
      startedAt: new Date().toISOString(),
    }
    writeFileSync(pidFilePathFor(dataDir, 'serve'), `${JSON.stringify(record)}\n`, { mode: JOURNAL_FILE_MODE })
    const { probe, dialled } = recordingProbe(['127.0.0.1'])

    const status = await statusOf('serve', { probe })

    expect(status.state).toBe('running')
    expect(dialled).toEqual([{ service: 'serve', host: '127.0.0.1', port: config.serve.port }])
  })
})
