import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { JOURNAL_DIR_MODE, JOURNAL_FILE_MODE } from '../../src/config.js'
import { PID_RECORD_VERSION, type ServiceName } from '../../src/services/constants.js'
import { createServiceManager } from '../../src/services/manager.js'
import { pidFilePathFor, runDirFor } from '../../src/services/paths.js'
import type { PidRecord } from '../../src/services/pid-file.js'
import type { probeService } from '../../src/services/probe.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import type { InstallConfig } from '../../src/setup/schema.js'

/**
 * `status` carries the bind-exposure warning (Q31): a service whose bind other
 * hosts can reach says so on every `status`, not only at `setup`. The finding
 * itself is `withExposure`'s (`tests/services/exposure.test.ts`); this file
 * pins that the manager attaches it, and to WHICH host — the pid record's,
 * when there is one.
 *
 * Its own file rather than more of `manager.test.ts`, which is past the size
 * the project allows; the helpers it needs are small enough to restate
 * (`manager-probe-host.test.ts` precedent).
 */

/** No socket needed: exposure is a statement about the bind, not about an answer. */
const silentProbe: typeof probeService = async () => false

const cleanups: Array<() => Promise<void>> = []
let dataDir: string
let config: InstallConfig

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined)
  }
})

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mcpcut-manager-exposure-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  config = defaultInstallConfig(dataDir)
})

function statusOf(service: ServiceName) {
  return createServiceManager({ dataDir, config, probe: silentProbe }).status(service)
}

/** A pid that is certainly gone: a process that has already exited. */
async function reapedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(child, 'exit')
  const pid = child.pid
  if (pid === undefined) throw new Error('short-lived helper did not spawn')
  return pid
}

/** Writes a pid record at the address the service was started on, the way a crashed run leaves one. */
function plantPidFile(service: ServiceName, pid: number, host: string, port: number): void {
  mkdirSync(runDirFor(dataDir), { recursive: true, mode: JOURNAL_DIR_MODE })
  const record: PidRecord = {
    version: PID_RECORD_VERSION,
    service,
    pid,
    host,
    port,
    startedAt: new Date().toISOString(),
  }
  writeFileSync(pidFilePathFor(dataDir, service), `${JSON.stringify(record)}\n`, {
    mode: JOURNAL_FILE_MODE,
  })
}

describe('status: bind exposure (Q31)', () => {
  test('a wildcard ui bind with no pid file carries the exposure warning', async () => {
    config = { ...config, ui: { ...config.ui, host: '0.0.0.0' } }

    const status = await statusOf('ui')

    expect(status.state).toBe('stopped')
    expect(status.exposure?.level).toBe('warn')
    expect(status.exposure?.detail.startsWith('ui binds 0.0.0.0: reachable from the network.')).toBe(true)
  })

  test('a pid record on a wildcard host carries the warning too, judged on the record host', async () => {
    plantPidFile('serve', await reapedPid(), '0.0.0.0', config.serve.port)
    // The config is back on loopback after the start: the record still says 0.0.0.0.
    config = { ...config, serve: { ...config.serve, host: '127.0.0.1' } }

    const status = await statusOf('serve')

    expect(status.state).toBe('stale')
    expect(status.host).toBe('0.0.0.0')
    expect(status.exposure?.level).toBe('warn')
  })

  test('the default loopback install has no exposure key at all', async () => {
    const status = await statusOf('ui')

    expect('exposure' in status).toBe(false)
  })
})
