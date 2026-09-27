import type { HttpFront } from '../transport/http/server.js'
import type { ServeCliIo } from './serve-constants.js'
import type { ServeCommandOptions } from './serve-options.js'
import type { ResidentsLifecycle } from './serve-pool-wiring.js'

/**
 * How a `serve` run ends (split out of `serve-cmd.ts`, which keeps the start):
 * the signal handlers, the caller's shutdown handle, and the RS10 teardown
 * order. Shutdown is a handler, not a signal — SIGINT/SIGTERM merely call the
 * same `shutdown()` the handle exposes.
 */

/** What one run starts, listens with, and tears down. */
export interface ServeRuntime {
  readonly front: HttpFront
  readonly residents: ResidentsLifecycle
}

export interface BoundAddress {
  readonly port: number
  readonly host: string
}

const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM']

/**
 * RS10, in this order: seal the supervisor (a pool session closing from here
 * on closes its held sessions instead of handing them back), close the front
 * (every pool session goes), then stop reconciling and close every held
 * session. Without the seal, a pool closed by the front would return its
 * children to a supervisor that was about to stop looking.
 */
async function closeRuntime(runtime: ServeRuntime): Promise<void> {
  runtime.residents.seal()
  try {
    await runtime.front.close()
  } finally {
    await runtime.residents.close()
  }
}

/**
 * Installs the signal handlers, hands the caller its handle, and resolves
 * once the front has closed. The handlers are removed in every exit path, so
 * a `serve` run never leaves listeners on the process behind it.
 */
export async function waitForShutdown(
  runtime: ServeRuntime,
  io: ServeCliIo,
  opts: ServeCommandOptions,
  address: BoundAddress,
): Promise<void> {
  let settleRun: () => void = () => undefined
  const finished = new Promise<void>((resolve) => {
    settleRun = resolve
  })
  let closing: Promise<void> | null = null
  /**
   * Never rejects: a shutdown triggered by a signal has nobody to catch it,
   * and a caller awaiting the handle must not have to guard the teardown of
   * a run that already did its job. A failure is reported and swallowed.
   */
  const shutdown = (): Promise<void> => {
    closing ??= closeRuntime(runtime)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        io.stderr.write(`serve: shutdown did not complete cleanly: ${message}\n`)
      })
      .finally(() => settleRun())
    return closing
  }

  const signals = opts.signals ?? DEFAULT_SIGNALS
  const installed: Array<[NodeJS.Signals, NodeJS.SignalsListener]> = signals.map((signal) => {
    const listener: NodeJS.SignalsListener = () => {
      io.stderr.write(`serve: ${signal} received, shutting down\n`)
      void shutdown()
    }
    process.on(signal, listener)
    return [signal, listener]
  })

  try {
    opts.onListening?.({ port: address.port, host: address.host, shutdown })
    await finished
  } finally {
    for (const [signal, listener] of installed) {
      process.removeListener(signal, listener)
    }
  }
}

