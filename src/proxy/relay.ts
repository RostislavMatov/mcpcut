import type { Readable, Writable } from 'node:stream'
import type {
  ClientServerDirection,
  JournalDirection,
  RecordBuilder,
} from '../journal/record.js'
import type { JournalSink } from '../journal/sink.js'
import type { Policy } from '../policy/schema.js'
import { classify } from '../protocol/classify.js'
import type { GateAgentScope } from './gate.js'
import type { ServerHandle } from './spawn.js'
import { splice, type SpliceErrorOrigin, type SpliceHandle } from './splice.js'
import { wirePolicyRelay, type RelayWiring } from './wire-policy.js'

/**
 * Relay mode selection for one wrapped session, plus the mode A (M1) relay
 * itself and the journal taps both modes share.
 *
 * Mode A is not merely the default: it is the *untouched* M1 path. A run
 * without a policy has to behave exactly as it did before policies existed
 * — byte-for-byte splices with a passive journal tap — which is why the two
 * modes are separate wirings rather than one parameterised relay.
 *
 * Mode B (`wire-policy.ts`) reuses `tapMessage`/`tapStderr` from here, so
 * "every line is journaled" means the same thing in both modes and cannot
 * drift between them.
 */

export interface RelayArgs {
  readonly handle: ServerHandle
  readonly clientStdin: Readable
  readonly clientStdout: Writable
  readonly clientStderr: Writable
  readonly recordBuilder: RecordBuilder
  readonly sink: JournalSink
  /** Routes a stream/tap failure to the run's shutdown controller. */
  readonly reportError: (
    channel: JournalDirection,
    error: unknown,
    origin: SpliceErrorOrigin,
  ) => void
  readonly sessionId: string
  /** Absent means mode A: the M1 splice relay, with nothing intercepted. */
  readonly policy: Policy | undefined
  readonly serverName: string
  readonly journalDir?: string
  readonly approvalsBaseDir?: string
  readonly inventoryStorePath?: string
  /** The authenticated agent's scope (M3, `connect`); absent for ad-hoc `wrap`. */
  readonly agentScope?: GateAgentScope
}

/** Wires client stdio through the child, in whichever mode this run calls for. */
export function wireRelay(args: RelayArgs): RelayWiring {
  return args.policy === undefined ? wireSplices(args) : wirePipelines(args, args.policy)
}

/** Mode B: message pipelines around the policy gate. */
function wirePipelines(args: RelayArgs, policy: Policy): RelayWiring {
  const { recordBuilder, sink, clientStderr } = args
  return wirePolicyRelay({
    policy,
    serverName: args.serverName,
    sessionId: args.sessionId,
    handle: args.handle,
    clientStdin: args.clientStdin,
    clientStdout: args.clientStdout,
    clientStderr,
    sink,
    tapLine: (line, direction) => tapMessage(recordBuilder, sink, line, direction, clientStderr),
    tapStderrLine: (line) => tapStderr(recordBuilder, sink, line, clientStderr),
    reportError: args.reportError,
    ...(args.journalDir !== undefined ? { journalDir: args.journalDir } : {}),
    ...(args.approvalsBaseDir !== undefined ? { approvalsBaseDir: args.approvalsBaseDir } : {}),
    ...(args.inventoryStorePath !== undefined
      ? { inventoryStorePath: args.inventoryStorePath }
      : {}),
    ...(args.agentScope !== undefined ? { agentScope: args.agentScope } : {}),
  })
}

/** Mode A: splices client stdio through the child in both directions, tapping each line into the journal. */
function wireSplices(args: RelayArgs): RelayWiring {
  const { handle, clientStderr, recordBuilder, sink } = args
  const errorsOf =
    (channel: JournalDirection) =>
    (error: unknown, origin: SpliceErrorOrigin): void =>
      args.reportError(channel, error, origin)

  const toServer = splice(
    args.clientStdin,
    handle.stdin,
    (line) => tapMessage(recordBuilder, sink, line, 'client→server', clientStderr),
    { onError: errorsOf('client→server') },
  )

  const toClient = splice(
    handle.stdout,
    args.clientStdout,
    (line) => tapMessage(recordBuilder, sink, line, 'server→client', clientStderr),
    { endDestination: false, onError: errorsOf('server→client') },
  )

  const stderrRelay = splice(
    handle.stderr,
    clientStderr,
    (line) => tapStderr(recordBuilder, sink, line, clientStderr),
    { endDestination: false, onError: errorsOf('server-stderr') },
  )

  const all: readonly SpliceHandle[] = [toServer, toClient, stderrRelay]
  return {
    dispose: () => {
      for (const spliceHandle of all) {
        spliceHandle.dispose()
      }
    },
    // Deliberately excludes toServer: the client's stdin may stay open long
    // after the child exited, and waiting on it would hang the proxy.
    relayed: Promise.all([toClient.relayed, stderrRelay.relayed]).then(() => undefined),
    // Nothing is ever deferred in mode A: no message is held back, so there
    // is nothing to cancel.
    cancelPending: () => Promise.resolve(),
  }
}

/**
 * Classifies and journals one client<->server line. Wrapped defensively so
 * a classify/build/write failure can never propagate into the forwarding
 * path, even though splice already isolates tap errors on its own.
 */
export function tapMessage(
  recordBuilder: RecordBuilder,
  sink: JournalSink,
  line: string,
  direction: ClientServerDirection,
  diagnostics: Writable,
): void {
  try {
    const classified = classify(line)
    sink.write(recordBuilder.buildRecord(classified, direction))
  } catch (error) {
    logTapError(diagnostics, error)
  }
}

/** Journals one raw stderr line from the wrapped server. Never throws into the relay. */
export function tapStderr(
  recordBuilder: RecordBuilder,
  sink: JournalSink,
  line: string,
  diagnostics: Writable,
): void {
  try {
    sink.write(recordBuilder.buildStderrRecord(line))
  } catch (error) {
    logTapError(diagnostics, error)
  }
}

/** One diagnostic line for a journal tap that failed. Shared with the shutdown controller. */
export function logTapError(diagnostics: Writable, error: unknown): void {
  diagnostics.write(
    `[wrap] failed to journal a line: ${error instanceof Error ? error.message : String(error)}\n`,
  )
}
