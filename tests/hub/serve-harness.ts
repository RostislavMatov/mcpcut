import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { runHubCli, type HubCliIo } from '../../hub/src/cli.js'
import type { SweepSchedule, SweepScheduler } from '../../hub/src/idle-sweeper.js'

/**
 * `hub serve` for the background-work tests (`serve-sweep`, `serve-reconcile`):
 * start it, wait for its output BY CONDITION — with a bound far above any
 * interval in play, failing loudly with the output on expiry rather than
 * giving up quietly — act, then shut it down. Nothing here waits a fixed time.
 */

/** Far above the tests' 20 ms sweep interval (×500) and the hub's own start-up. */
export const OUTPUT_WAIT_MS = 10_000
const POLL_MS = 10

export interface ServedHub {
  readonly out: () => string
  /** Resolves the shutdown promise and returns the exit code. */
  readonly stop: () => Promise<number>
}

export async function startServe(dir: string, dataDir: string, io: Partial<HubCliIo>): Promise<ServedHub> {
  const secretFile = join(dir, 'github-client-secret')
  await writeFile(secretFile, 'the-client-secret-value\n')
  await chmod(secretFile, 0o600)
  let release: () => void = () => undefined
  const shutdown = new Promise<void>((resolve) => (release = resolve))
  let out = ''
  const running = runHubCli(['serve'], {
    env: {
      HUB_PUBLIC_URL: 'https://mcpcut.test',
      HUB_GITHUB_CLIENT_ID: 'Ov23liTestClientId',
      HUB_GITHUB_CLIENT_SECRET_FILE: secretFile,
      HUB_DATA_DIR: dataDir,
      HUB_PORT: '0',
    },
    stdout: (text) => (out += text),
    stderr: (text) => (out += text),
    shutdown,
    ...io,
  })
  return {
    out: () => out,
    stop: async () => {
      release()
      return running
    },
  }
}

/** Waits until `done` holds of the output; fails with the output after `OUTPUT_WAIT_MS`. */
export async function waitForOutput(hub: ServedHub, done: (out: string) => boolean): Promise<void> {
  await vi.waitFor(() => expect(done(hub.out()), hub.out()).toBe(true), { timeout: OUTPUT_WAIT_MS, interval: POLL_MS })
}

/** A sweep scheduler driven by hand: no timer, so "no sweep" is a fact, not a pause. */
export interface ManualScheduler {
  readonly scheduler: SweepScheduler
  /** Runs one sweep as the timer would; fails if nothing was scheduled or the schedule was stopped. */
  readonly tick: () => Promise<void>
  /** How many schedules serve asked for, and with what. */
  readonly scheduled: () => readonly SweepSchedule[]
  readonly isStopped: () => boolean
}

export function manualScheduler(): ManualScheduler {
  let run: (() => Promise<unknown>) | undefined
  let stopped = false
  const schedules: SweepSchedule[] = []
  return {
    scheduler: (sweep, schedule) => {
      run = sweep
      schedules.push(schedule)
      return {
        stop: () => {
          stopped = true
        },
      }
    },
    tick: async () => {
      if (run === undefined || stopped) throw new Error('manual scheduler: no live schedule to tick')
      await run()
    },
    scheduled: () => [...schedules],
    isStopped: () => stopped,
  }
}
