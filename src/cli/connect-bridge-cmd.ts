import type { Readable, Writable } from 'node:stream'
import { parseArgs } from 'node:util'
import { runBridge, type BridgeEnd, type BridgeEndpoints } from '../bridge/pump.js'
import { EXIT_CODE_BRIDGE_LOST } from '../bridge/constants.js'
import { checkBridgeScheme, parseBridgeUrl, type BridgeUrl } from '../bridge/url.js'
import { guardDiagnostics } from '../proxy/diagnostics.js'
import { createOrderedWriter } from '../proxy/writer.js'
import { perMessageHeadersOptionOf } from '../session/per-message-headers.js'
import {
  createHttpUpstreamClient,
  type HttpUpstreamClient,
  type HttpUpstreamClientOptions,
} from '../transport/http/client.js'
import { createStdioMessageSink } from '../transport/stdio-adapter.js'
import { createReadableMessageSource } from '../upstream/readable-source.js'
import { DIAGNOSTIC_PREFIX } from '../upstream/constants.js'
import type { ConnectCliIo } from './connect-cmd.js'
import { AGENT_TOKEN_ENV_VAR, EXIT_CODE_REFUSED, missingTokenMessage } from './connect-constants.js'
import {
  AGENT_TOKEN_MARKER,
  BRIDGE_USAGE,
  forbiddenMessage,
  mixedModeMessage,
  noEndpointMessage,
  plainHttpRefusedMessage,
  plainHttpWarning,
  sessionExpiredMessage,
  streamLostMessage,
  tokenInArgvMessage,
  unauthorizedMessage,
} from './connect-bridge-messages.js'

/**
 * `mcpcut connect --url <address>` — the REMOTE form of connect (ADR-0015).
 *
 * The local form resolves a server from this machine's registry, dereferences
 * its secrets from this machine's vault and journals into this machine's
 * databases. This one does none of that: it is a stdio client of ANOTHER
 * host's `serve` front, and the whole point is that it runs where no install
 * exists. It therefore routes in `cli.ts` ahead of the broken-config gate,
 * exactly as `--remote` does, and the modules under `src/bridge/` are barred
 * by `tests/architecture/imports.test.ts` from importing any install state at
 * all.
 *
 * **stdout is the protocol channel**: the only thing ever written there is
 * what the service said. Refusals, warnings and failures go to stderr.
 *
 * Order is the security story here, as it is in the local form: every refusal
 * below is decided before a single byte reaches the network, and the argv
 * check comes before `parseArgs` so a token typed in the wrong place is
 * caught even when the rest of the command line is nonsense.
 */

export interface ConnectBridgeDeps {
  /** Source of `MCP_AGENT_TOKEN`. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Client-facing input (the agent's requests). Defaults to `process.stdin`. */
  readonly stdin?: Readable
  /** Client-facing output (the protocol channel). Defaults to `process.stdout`. */
  readonly stdout?: Writable
  /** @internal test seam: the HTTP client factory. */
  readonly createClient?: typeof createHttpUpstreamClient
  /** @internal test seam: delays and reconnect budgets, so a test need not wait them out. */
  readonly clientOptions?: HttpUpstreamClientOptions
}

const DEFAULT_IO: ConnectCliIo = { stderr: process.stderr }

/**
 * Whether this `connect` invocation means the bridge. Deliberately a text
 * test over raw argv rather than a parse: `cli.ts` must choose the branch
 * BEFORE the config gate, and a malformed `--url=` still belongs to this
 * command (which explains itself) rather than to the local form (which would
 * refuse for the wrong reason).
 */
export function isBridgeInvocation(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--url' || arg.startsWith('--url='))
}

/** Flags that would carry a token, recognized only so the refusal can explain itself. */
const TOKEN_BEARING_FLAGS: readonly string[] = ['--token', '--header', '--authorization']

/**
 * True when argv holds a token, or a flag whose purpose is to carry one. The
 * check is over the RAW arguments, ahead of parsing, because `--token=mcpj_…`
 * and a bare positional are equally fatal and `parseArgs` would throw on the
 * malformed cases before either could be noticed.
 */
function hasTokenInArgv(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg.includes(AGENT_TOKEN_MARKER) ||
      TOKEN_BEARING_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  )
}

interface BridgeFlags {
  readonly url: string
  readonly allowHttp: boolean
}

/** Parses argv strictly. `undefined` means "print the usage": no `--url`, or the local form's arguments. */
function parseBridgeFlags(args: readonly string[]): BridgeFlags | undefined {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: {
        url: { type: 'string' },
        'allow-http': { type: 'boolean', default: false },
        // Recognized only so `--agent` produces the mixed-mode explanation
        // rather than a bare "unknown option".
        agent: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    })
    if (values.url === undefined || values.url.length === 0) return undefined
    if (positionals.length > 0 || values.agent !== undefined) return undefined
    return { url: values.url, allowHttp: values['allow-http'] === true }
  } catch {
    return undefined
  }
}

/** What the invocation resolved to: everything needed to dial, or the line explaining why not. */
type Resolution =
  | { readonly ok: true; readonly url: BridgeUrl; readonly token: string; readonly warning?: string }
  | { readonly ok: false; readonly message: string }

/**
 * Every refusal this command can decide before touching the network, in the
 * order it decides them.
 */
function resolveInvocation(args: readonly string[], env: NodeJS.ProcessEnv): Resolution {
  if (hasTokenInArgv(args)) return { ok: false, message: tokenInArgvMessage() }

  const flags = parseBridgeFlags(args)
  if (flags === undefined) {
    // A server name or `--agent` alongside `--url` is a distinct mistake — two
    // different commands were mixed — and earns its own explanation.
    const isMixed = args.some((arg) => arg === '--agent' || arg.startsWith('--agent='))
    return { ok: false, message: isMixed ? mixedModeMessage() : BRIDGE_USAGE }
  }

  const parsed = parseBridgeUrl(flags.url)
  if (!parsed.ok) return { ok: false, message: parsed.message }
  const url = parsed.url

  const verdict = checkBridgeScheme(url, flags.allowHttp)
  if (verdict === 'refuse') return { ok: false, message: plainHttpRefusedMessage(url.origin) }

  const token = env[AGENT_TOKEN_ENV_VAR]
  if (token === undefined || token.length === 0) {
    return { ok: false, message: missingTokenMessage() }
  }

  return {
    ok: true,
    url,
    token,
    ...(verdict === 'warn' ? { warning: plainHttpWarning(url.origin) } : {}),
  }
}

/** The exit code and the stderr line one ending earns. */
function reportEnd(end: BridgeEnd, url: BridgeUrl, io: ConnectCliIo): number {
  if (end.reason === 'client-ended') return 0
  switch (end.failure.kind) {
    case 'unauthorized':
      io.stderr.write(unauthorizedMessage(url.origin))
      return EXIT_CODE_REFUSED
    case 'forbidden':
      io.stderr.write(forbiddenMessage(url.origin))
      return EXIT_CODE_REFUSED
    case 'no-endpoint':
      io.stderr.write(noEndpointMessage(url.origin, url.isPoolAddress))
      return EXIT_CODE_REFUSED
    case 'session-expired':
      io.stderr.write(sessionExpiredMessage(url.origin))
      return EXIT_CODE_BRIDGE_LOST
    // No `default`: `BridgeEnd`'s fatal payload is the narrowed
    // `FatalBridgeFailure`, so a fatal kind added later and forgotten here is
    // a compile error rather than a wrong message and a wrong exit code.
    case 'stream-lost':
      io.stderr.write(streamLostMessage(url.origin))
      return EXIT_CODE_BRIDGE_LOST
  }
}

/** Opens the HTTP client for one resolved address. The token goes in one header and nowhere else. */
function openService(
  resolved: Extract<Resolution, { ok: true }>,
  deps: ConnectBridgeDeps,
): HttpUpstreamClient {
  return (deps.createClient ?? createHttpUpstreamClient)(
    {
      url: resolved.url.endpoint,
      // ONLY the authorization header. The client spreads `record.headers`
      // last, so anything else here would override `content-type`/`accept`.
      headers: { authorization: `Bearer ${resolved.token}` },
      // The bridge cannot know the service's session model and must not
      // choose one: `auto` lets the transport detect it from the first
      // response, and the per-message headers go out either way (SEP-2243
      // requires them on 2026-07-28, older revisions ignore them).
      protocol: 'auto',
    },
    { ...perMessageHeadersOptionOf('auto'), ...deps.clientOptions },
  )
}

/** The agent-facing endpoints: this process's own stdio, framed as messages. */
function buildClientEndpoints(args: {
  readonly stdin: Readable
  readonly stdout: Writable
  readonly onDiagnostic: (line: string) => void
}): BridgeEndpoints {
  const writer = createOrderedWriter(args.stdout, {
    onError: (error) =>
      args.onDiagnostic(`${DIAGNOSTIC_PREFIX} client stdout: ${describe(error)}\n`),
  })
  return {
    // `dropBlanks`: a blank line has no HTTP representation, so it must never
    // become an empty POST body.
    source: createReadableMessageSource(args.stdin, 'client', {
      dropBlanks: true,
      onOverflow: (byteLength) =>
        args.onDiagnostic(
          `${DIAGNOSTIC_PREFIX} dropped an oversized unterminated client fragment (${byteLength} bytes)\n`,
        ),
    }),
    sink: createStdioMessageSink(writer),
  }
}

/**
 * Lets go of both sides, whichever way the bridge ended. A fatal ending
 * leaves the HTTP client holding a GET stream and possibly a session;
 * `close()` is idempotent, so the ordinary path pays nothing. Both sources
 * are disposed for symmetry with the sinks and with the `MessageSource`
 * contract.
 */
async function teardown(
  client: BridgeEndpoints,
  service: HttpUpstreamClient,
  stdin: Readable,
): Promise<void> {
  await service.close()
  service.source.dispose()
  client.source.dispose()
  client.sink.dispose()
  // A source that was disposed has no listeners left, but a resumed stream
  // still holds the event loop open; the bridge must not outlive its session.
  stdin.pause()
}

/**
 * Runs one bridge to completion and resolves with its exit code: 0 when the
 * agent's client hung up, 1 for anything decided before or instead of a
 * session, and `EXIT_CODE_BRIDGE_LOST` when the session itself was lost —
 * which tells a client to start a fresh bridge rather than to give up.
 */
export async function runConnectBridge(
  args: readonly string[],
  io: ConnectCliIo = DEFAULT_IO,
  deps: ConnectBridgeDeps = {},
): Promise<number> {
  const resolved = resolveInvocation(args, deps.env ?? process.env)
  if (!resolved.ok) {
    io.stderr.write(resolved.message)
    return EXIT_CODE_REFUSED
  }
  if (resolved.warning !== undefined) io.stderr.write(resolved.warning)

  const stdin = deps.stdin ?? process.stdin
  // Guarded so a stderr failure reported as a diagnostic cannot re-enter
  // stderr (`proxy/diagnostics.ts`: the orphaned-connect 100% CPU loop).
  const diagnostics = guardDiagnostics(io.stderr)
  const onDiagnostic = (line: string): void => {
    diagnostics.write(line)
  }

  const service = openService(resolved, deps)
  const client = buildClientEndpoints({
    stdin,
    stdout: deps.stdout ?? process.stdout,
    onDiagnostic,
  })

  const end = await runBridge({ client, service, onDiagnostic })
  await teardown(client, service, stdin)

  return reportEnd(end, resolved.url, io)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
