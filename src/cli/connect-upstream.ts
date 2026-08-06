import type { Writable } from 'node:stream'
import { SYSTEM_ENV_ALLOWLIST } from '../config.js'
import { extractPerMessageHeaders } from '../protocol/mcp.js'
import { buildServerEnv } from '../proxy/server-env.js'
import type { ResolveEnvRefsFn } from '../proxy/server-env.js'
import {
  DEFAULT_FORWARDED_SIGNALS,
  installSignalForwarding,
  killWithEscalation,
  spawnServer,
  type ServerHandle,
} from '../proxy/spawn.js'
import { splice } from '../proxy/splice.js'
import { createOrderedWriter } from '../proxy/writer.js'
import type { ServerRecord } from '../registry/schema.js'
import type { SessionEndpoints } from '../session/core.js'
import {
  createHttpUpstreamClient,
  type HttpUpstreamClient,
  type HttpUpstreamProtocol,
} from '../transport/http/client.js'
import { createStdioMessageSink } from '../transport/stdio-adapter.js'
import type { ResolveVaultRefsResult } from '../vault/resolve.js'
import { CHILD_EXIT_GRACE_MS, DIAGNOSTIC_PREFIX } from './connect-constants.js'
import { createReadableMessageSource } from './connect-source.js'

/**
 * The upstream half of one `connect` session: a registry record turned into
 * the `MessageSource`/`MessageSink` pair `session/core.ts` consumes, for both
 * transports.
 *
 * Two-phase on purpose. `prepareUpstream` does everything that can fail or
 * await — dereferencing `vault:` refs for a child's env or an HTTP record's
 * headers — and refuses BEFORE anything is spawned or connected. `open()` is
 * then strictly synchronous, so the caller can create the client endpoints
 * and hand both to `createSession` without an await in between (message
 * sources start delivering on a later tick, and their handlers must be
 * registered before that).
 *
 * Transport differences the caller must honor are declared, not hidden:
 * `dropClientBlanks` (an HTTP POST has no representation for a blank line)
 * and `guardInitialize` (a stateless upstream must never be handed a
 * sessionful handshake — ADR-0002).
 *
 * Secrets: dereferenced values exist only inside the child's env record or
 * the client's header map. Nothing here logs them, and a failure reports
 * secret NAMES only.
 */

/** Live upstream for one session. */
export interface ConnectUpstream {
  readonly endpoints: SessionEndpoints
  /**
   * Settles when the upstream can no longer produce anything, INDEPENDENTLY
   * of its message source: a child that could not be spawned at all never
   * ends its stdout, so the session would otherwise wait forever. HTTP
   * upstreams have no such out-of-band death and never settle this.
   */
  readonly gone: Promise<void>
  /**
   * stdio only: relays the child's stderr to the operator's stderr while
   * journaling each line through `tap`. Wired after the session exists, since
   * the tap needs its record builder. A no-op for HTTP upstreams.
   */
  attachStderr(tap: (line: string) => void): void
  /**
   * Shuts the upstream down after the session has ended and resolves with the
   * exit code it contributes (the child's own for stdio, 0 for HTTP).
   */
  finish(): Promise<number>
  /** Detaches everything this upstream installed (signal handlers, stderr relay). */
  dispose(): void
}

export interface PreparedUpstream {
  /** Blank client lines must not be POSTed to an HTTP upstream. */
  readonly dropClientBlanks: boolean
  /** True for a `protocol: 'stateless'` record: the client's first message must not be `initialize`. */
  readonly guardInitialize: boolean
  /** Synchronous: spawns / connects and wires the endpoints. */
  open(): ConnectUpstream
}

export type PrepareUpstreamResult =
  | { readonly status: 'prepared'; readonly upstream: PreparedUpstream }
  /** Vault/env resolution failed; `message` is the complete operator text. */
  | { readonly status: 'refused'; readonly message: string }

export interface PrepareUpstreamArgs {
  readonly record: ServerRecord
  /** The control plane's own environment (the allowlist slice of it reaches a child). */
  readonly processEnv: NodeJS.ProcessEnv
  /** Dereferences `vault:` values; typically `resolveVaultRefs` bound to a vault store. */
  readonly resolveRefs: ResolveEnvRefsFn
  /** Working directory for a spawned child. */
  readonly cwd?: string
  /** Where the child's stderr is passed through to. Defaults to `process.stderr`. */
  readonly stderr?: Writable
  /** Diagnostics sink for upstream-level failures. */
  readonly onDiagnostic: (line: string) => void
  /** Grace period before SIGTERM after the child's stdin was closed. */
  readonly childExitGraceMs?: number
  /** Grace period between SIGTERM and SIGKILL. */
  readonly killEscalationMs?: number
  /** Names the child may inherit from `processEnv`. Defaults to `SYSTEM_ENV_ALLOWLIST`. */
  readonly systemEnvAllowlist?: readonly string[]
}

/** One operator line per resolution failure shape; every referenced-but-absent name is listed. */
export function formatVaultFailure(
  what: string,
  result: Exclude<ResolveVaultRefsResult, { readonly status: 'resolved' }>,
): string {
  if (result.status === 'missing-secrets') {
    return (
      `missing vault secret(s) for the server's ${what}: ${result.missing.join(', ')}\n` +
      `Add each with: mcp-journal vault set <name>\n`
    )
  }
  if (result.status === 'invalid-refs') {
    return `invalid vault reference(s) in the server's ${what}: ${result.refs.join(', ')}\n`
  }
  if (result.failure.status === 'not-initialized') {
    return 'the vault is not initialized; run: mcp-journal vault init\n'
  }
  return `the vault could not be read: ${result.failure.message}\n`
}

export async function prepareUpstream(args: PrepareUpstreamArgs): Promise<PrepareUpstreamResult> {
  if (args.record.transport === 'stdio') {
    const built = await buildServerEnv({
      processEnv: args.processEnv,
      allowlist: args.systemEnvAllowlist ?? SYSTEM_ENV_ALLOWLIST,
      declaredEnv: args.record.env ?? {},
      resolveRefs: args.resolveRefs,
    })
    if (built.status !== 'built') {
      return { status: 'refused', message: formatVaultFailure('env', built) }
    }
    const record = args.record
    const env = built.env
    return {
      status: 'prepared',
      upstream: {
        dropClientBlanks: false,
        guardInitialize: false,
        open: () => openStdioUpstream(args, record.command, record.args ?? [], env),
      },
    }
  }

  const resolved = await args.resolveRefs({ ...args.record.headers })
  if (resolved.status !== 'resolved') {
    return { status: 'refused', message: formatVaultFailure('headers', resolved) }
  }
  const record = args.record
  const headers = resolved.values
  return {
    status: 'prepared',
    upstream: {
      dropClientBlanks: true,
      guardInitialize: record.protocol === 'stateless',
      open: () => openHttpUpstream(record.url, headers, record.protocol),
    },
  }
}

/**
 * Waits for `exitCode` at most `timeoutMs`. The timer is unref'd so it can
 * never hold the process open on its own.
 */
function raceExit(exitCode: Promise<number>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(null)
    }, timeoutMs)
    timer.unref()
    exitCode.then(
      (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(code)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

/** Spawns the registry server with EXACTLY `env` (no `process.env` merge — see spawn.ts). */
function openStdioUpstream(
  args: PrepareUpstreamArgs,
  command: string,
  commandArgs: readonly string[],
  env: Readonly<Record<string, string>>,
): ConnectUpstream {
  const killEscalationMs = args.killEscalationMs ?? CHILD_EXIT_GRACE_MS
  const handle: ServerHandle = spawnServer(command, commandArgs, {
    env,
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
  })
  const signals = installSignalForwarding(handle, DEFAULT_FORWARDED_SIGNALS, { killEscalationMs })

  const source = createReadableMessageSource(handle.stdout, 'server', {
    onOverflow: (byteLength) =>
      args.onDiagnostic(
        `${DIAGNOSTIC_PREFIX} dropped an oversized unterminated server fragment (${byteLength} bytes)\n`,
      ),
  })
  const writer = createOrderedWriter(handle.stdin, {
    onError: (error) => args.onDiagnostic(`${DIAGNOSTIC_PREFIX} server stdin: ${describe(error)}\n`),
  })

  let stderrRelay: { dispose(): void } | null = null

  return {
    endpoints: { source, sink: createStdioMessageSink(writer) },
    // Either outcome means the child is gone; a spawn failure (ENOENT) is a
    // rejection here and never reaches the message source at all.
    gone: handle.exitCode().then(
      () => undefined,
      () => undefined,
    ),
    attachStderr: (tap) => {
      stderrRelay = splice(handle.stderr, args.stderr ?? process.stderr, tap, {
        endDestination: false,
        onError: (error) =>
          args.onDiagnostic(`${DIAGNOSTIC_PREFIX} server stderr: ${describe(error)}\n`),
      })
    },
    finish: () => finishChild(handle, args, killEscalationMs),
    dispose: () => {
      stderrRelay?.dispose()
      signals.uninstall()
    },
  }
}

/**
 * Ends the child and reports its exit code. Closing its stdin is the polite
 * exit — a well-behaved MCP server shuts itself down and reports its own code
 * — and signals are the fallback for one that does not.
 */
async function finishChild(
  handle: ServerHandle,
  args: PrepareUpstreamArgs,
  killEscalationMs: number,
): Promise<number> {
  try {
    handle.stdin.end()
  } catch (error: unknown) {
    args.onDiagnostic(`${DIAGNOSTIC_PREFIX} could not close the server's stdin: ${describe(error)}\n`)
  }
  const graceful = await raceExit(handle.exitCode(), args.childExitGraceMs ?? CHILD_EXIT_GRACE_MS)
  if (graceful !== null) {
    return graceful
  }
  killWithEscalation(handle, 'SIGTERM', killEscalationMs)
  try {
    return await handle.exitCode()
  } catch (error: unknown) {
    // The child could not be spawned at all (SpawnServerError).
    args.onDiagnostic(`${DIAGNOSTIC_PREFIX} ${describe(error)}\n`)
    return 1
  }
}

/**
 * Connects to an HTTP upstream. The stateless per-message headers
 * (`Mcp-Method`/`Mcp-Name`, SEP-2243 — REQUIRED for that revision per the
 * spec matrix) are injected ONLY for a record pinned to `'stateless'`: for
 * `'sessionful'` they are not part of the revision, and for `'auto'` the
 * model is not known until the first response, so sending them would be a
 * guess. The hook itself lives in `protocol/mcp.ts` — the transport stays
 * free of spec knowledge.
 */
function openHttpUpstream(
  url: string,
  headers: Record<string, string>,
  protocol: HttpUpstreamProtocol,
): ConnectUpstream {
  const client: HttpUpstreamClient = createHttpUpstreamClient(
    { url, headers, protocol },
    protocol === 'stateless' ? { perMessageHeaders: extractPerMessageHeaders } : {},
  )

  return {
    endpoints: { source: client.source, sink: client.sink },
    // An HTTP upstream reports every failure through its own source; there is
    // no process whose death could go unnoticed.
    gone: new Promise<void>(() => undefined),
    attachStderr: () => undefined,
    finish: async () => {
      await client.close()
      return 0
    },
    dispose: () => undefined,
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
