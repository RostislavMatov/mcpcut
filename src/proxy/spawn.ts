import { spawn as nodeSpawn } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import type { Readable, Writable } from 'node:stream'

/**
 * Child process lifecycle for the wrapped MCP server.
 *
 * This module knows nothing about JSON-RPC or the journal — only about
 * spawning a process, its three stdio streams, and its exit. Splicing
 * bytes between the streams and the proxy's own stdio lives in splice.ts.
 */

/** Exit-code base added to a signal's number when a process is killed by signal (POSIX convention). */
const SIGNAL_EXIT_CODE_BASE = 128

/** Fallback exit code when neither a numeric code nor a signal is reported. */
const DEFAULT_EXIT_CODE = 0

/** Signal number assumed when this platform does not define the reported signal. */
const UNKNOWN_SIGNAL_NUMBER = 0

/** Signals the proxy forwards to the child by default when it receives them itself. */
export const DEFAULT_FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT']

export interface ServerHandle {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly pid: number | undefined
  /**
   * Resolves with the mapped exit code once the child has exited *and* its
   * stdio has been fully drained, or rejects if the process could not be
   * spawned.
   */
  exitCode(): Promise<number>
  kill(signal?: NodeJS.Signals): void
}

export interface SpawnServerOptions {
  cwd?: string
}

/** Raised when the underlying spawn fails (e.g. ENOENT for a missing binary). */
export class SpawnServerError extends Error {
  constructor(command: string, args: readonly string[], cause: unknown) {
    super(`Failed to spawn "${[command, ...args].join(' ')}": ${describeCause(cause)}`, { cause })
    this.name = 'SpawnServerError'
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Maps a node child_process exit outcome to a single conventional exit code. */
export function mapExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (signal !== null) {
    // os.constants.signals omits signals this platform does not define (e.g.
    // SIGPWR on macOS); without the fallback that would yield 128 + undefined = NaN.
    return SIGNAL_EXIT_CODE_BASE + (osConstants.signals[signal] ?? UNKNOWN_SIGNAL_NUMBER)
  }
  return code ?? DEFAULT_EXIT_CODE
}

/**
 * Spawns the wrapped MCP server as a child process with piped stdio and
 * env inherited from process.env as-is (MCP servers receive credentials
 * via env — this is a product requirement, not an oversight).
 */
export function spawnServer(
  command: string,
  args: readonly string[] = [],
  opts: SpawnServerOptions = {},
): ServerHandle {
  const child = nodeSpawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  })

  const exitPromise = new Promise<number>((resolve, reject) => {
    child.once('error', (error) => {
      reject(new SpawnServerError(command, args, error))
    })
    // 'close' — not 'exit' — is the drain barrier: it fires once every stdio
    // stream has been closed, so no bytes are left unread in the OS pipes.
    // Resolving on 'exit' would cut relaying short mid-response.
    child.once('close', (code, signal) => {
      resolve(mapExitCode(code, signal))
    })
  })
  // Spawn failures must surface via exitCode(), never as an unhandled rejection.
  exitPromise.catch(() => undefined)

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    pid: child.pid,
    exitCode: () => exitPromise,
    kill: (signal) => {
      child.kill(signal)
    },
  }
}

export interface SignalForwardingHandle {
  /** Removes exactly the listeners this call installed, and no others. */
  uninstall(): void
}

/**
 * Installs process-level signal listeners that forward each signal to
 * `target.kill(signal)` — used so the proxy forwards SIGTERM/SIGINT it
 * receives on to the wrapped child process.
 */
export function installSignalForwarding(
  target: Pick<ServerHandle, 'kill'>,
  signals: readonly NodeJS.Signals[] = DEFAULT_FORWARDED_SIGNALS,
): SignalForwardingHandle {
  const installed: Array<[NodeJS.Signals, NodeJS.SignalsListener]> = signals.map((signal) => {
    const listener: NodeJS.SignalsListener = () => {
      target.kill(signal)
    }
    process.on(signal, listener)
    return [signal, listener]
  })

  return {
    uninstall: () => {
      for (const [signal, listener] of installed) {
        process.removeListener(signal, listener)
      }
    },
  }
}
