import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { JOURNAL_DIR } from '../config.js'
import type { ClientServerDirection, JournalDirection } from '../journal/record.js'
import type { JournalSink } from '../journal/sink.js'
import { createGrantRegistry } from '../policy/approvals/grants.js'
import { createApprovalQueue } from '../policy/approvals/queue.js'
import { createApprovalWaiter } from '../policy/approvals/waiter.js'
import { canonicalJson, sha256Hex } from '../policy/hash.js'
import { createInventory, INVENTORY_FILE_NAME } from '../policy/inventory.js'
import type { Policy } from '../policy/schema.js'
import { createPolicyGate } from './gate.js'
import { startPipeline, type GateFn } from './pipeline.js'
import type { ServerHandle } from './spawn.js'
import { splice, type SpliceErrorOrigin } from './splice.js'
import { createOrderedWriter } from './writer.js'

/**
 * Mode B wiring: the relay used when a policy is active.
 *
 * Mode A (no policy) stays byte-for-byte the M1 splice relay and lives in
 * `wrap.ts`. Mode B replaces the two stdio splices with message pipelines
 * around the semantic gate:
 *
 *   client stdin --pipeline--> gate --> writer --> child stdin
 *   child stdout --pipeline--> gate --> writer --> client stdout
 *
 * The stderr direction is deliberately untouched (still a splice with a
 * journal tap): nothing is ever gated there.
 *
 * Two wiring details are load-bearing and easy to get wrong:
 *  - The gate's `clientWriter` **is** the writer the server->client pipeline
 *    writes through. Synthetic errors and relayed responses must share one
 *    serialized queue, or a locally-injected error could interleave inside a
 *    relayed line.
 *  - Ordinary traffic is journaled by the gate wrappers below, *before* the
 *    gate is consulted. In mode A the splice tap journals every line; the
 *    pipelines replace the splices, so they must keep that promise. Decision
 *    records the gate writes are additional, never a substitute.
 */

/** Prefix of a proxy-generated server identity (see `autoServerName`). */
const AUTO_SERVER_NAME_PREFIX = 'auto:'

/** Hex characters of the command hash kept in a proxy-generated server identity. */
const AUTO_SERVER_NAME_HASH_CHARS = 12

/** Subdirectory holding the approvals queue, under the journal directory. */
const APPROVALS_SUBDIR = 'approvals'

/**
 * Stable identity for a wrapped server that was not given an explicit
 * `--server` name: the same command + args always hash to the same name, so
 * quarantine and policy rules keyed on it survive across sessions. The
 * registry that would hand out real names is M3.
 */
export function autoServerName(command: string, args: readonly string[]): string {
  const digest = sha256Hex(canonicalJson([command, ...args]))
  return `${AUTO_SERVER_NAME_PREFIX}${digest.slice(0, AUTO_SERVER_NAME_HASH_CHARS)}`
}

/** What `wrap.ts` needs from a relay, whichever mode produced it. */
export interface RelayWiring {
  /** Detaches every listener this relay installed, in all three directions. */
  readonly dispose: () => void
  /** Resolves once all server->client output (stdout and stderr) has been relayed. */
  readonly relayed: Promise<void>
  /**
   * Settles every in-flight approval wait so the client still gets an answer.
   * Must run *before* `dispose()`, which tears the writers down. A no-op in
   * mode A, which has nothing pending.
   */
  readonly cancelPending: () => Promise<void>
}

export interface PolicyRelayArgs {
  /** Already carries any `--fail-closed` override; the gate reads it from here. */
  readonly policy: Policy
  readonly serverName: string
  readonly sessionId: string
  readonly handle: ServerHandle
  readonly clientStdin: Readable
  readonly clientStdout: Writable
  readonly clientStderr: Writable
  readonly sink: JournalSink
  /** Journals one client<->server line, exactly as mode A's splice tap does. */
  readonly tapLine: (line: string, direction: ClientServerDirection) => void
  /** Journals one raw stderr line from the wrapped server. */
  readonly tapStderrLine: (line: string) => void
  /** Routes a stream/tap failure to the shutdown controller, as in mode A. */
  readonly reportError: (
    channel: JournalDirection,
    error: unknown,
    origin: SpliceErrorOrigin,
  ) => void
  /** Journal directory, used to derive the approvals and inventory locations. */
  readonly journalDir?: string
  readonly approvalsBaseDir?: string
  readonly inventoryStorePath?: string
}

/** Where the policy layer's on-disk state lives for one run. */
interface PolicyPaths {
  readonly approvalsBaseDir: string
  readonly inventoryStorePath: string
}

/**
 * Both locations default *under the journal directory*, not under
 * `JOURNAL_DIR` unconditionally: a run pointed at a different journal dir
 * must not write its approvals and inventory into the user's home.
 */
function policyPathsOf(args: PolicyRelayArgs): PolicyPaths {
  const baseDir = args.journalDir ?? JOURNAL_DIR
  return {
    approvalsBaseDir: args.approvalsBaseDir ?? join(baseDir, APPROVALS_SUBDIR),
    inventoryStorePath: args.inventoryStorePath ?? join(baseDir, INVENTORY_FILE_NAME),
  }
}

/**
 * Journals a frame before handing it to the gate, so "everything is
 * journaled" survives the move from splice taps to pipelines. Blank frames
 * never reach a gate (the pipeline forwards them directly), so they skip
 * both the tap and the gate — matching mode A, whose framer drops them too.
 */
function tappedGate(
  gate: GateFn,
  direction: ClientServerDirection,
  tapLine: PolicyRelayArgs['tapLine'],
): GateFn {
  return (frame) => {
    tapLine(frame.bytes.toString('utf8'), direction)
    return gate(frame)
  }
}

export function wirePolicyRelay(args: PolicyRelayArgs): RelayWiring {
  const { approvalsBaseDir, inventoryStorePath } = policyPathsOf(args)

  const clientWriter = createOrderedWriter(args.clientStdout, {
    onError: (error) => args.reportError('server→client', error, 'destination'),
  })
  const serverWriter = createOrderedWriter(args.handle.stdin, {
    onError: (error) => args.reportError('client→server', error, 'destination'),
  })

  const gate = createPolicyGate({
    policy: args.policy,
    serverName: args.serverName,
    sessionId: args.sessionId,
    inventory: createInventory(args.serverName, { storePath: inventoryStorePath }),
    approvalQueue: createApprovalQueue({ baseDir: approvalsBaseDir }),
    approvalWaiter: createApprovalWaiter(),
    grantRegistry: createGrantRegistry(),
    sink: args.sink,
    clientWriter,
    approvalsBaseDir,
    // A gate-internal failure is a proxy defect, not a broken stream: log it
    // (the gate has already failed the call closed) and keep the session up.
    onError: (error) => args.reportError('client→server', error, 'tap'),
  })

  /**
   * Ends the child's stdin once the client's has ended — the lifecycle step
   * `splice(endDestination: true)` performed in mode A, which the pipeline
   * deliberately leaves to whoever owns both directions. A child that is
   * already gone surfaces here as EPIPE, which the shutdown controller
   * recognises as a normal end of session.
   */
  function endServerStdin(): void {
    try {
      args.handle.stdin.end()
    } catch (error: unknown) {
      args.reportError('client→server', error, 'destination')
    }
  }

  const toServer = startPipeline(
    args.clientStdin,
    serverWriter,
    tappedGate(gate.gateClientMessage, 'client→server', args.tapLine),
    {
      onError: (error) => args.reportError('client→server', error, 'source'),
      onEnd: endServerStdin,
    },
  )

  const toClient = startPipeline(
    args.handle.stdout,
    clientWriter,
    tappedGate(gate.gateServerMessage, 'server→client', args.tapLine),
    { onError: (error) => args.reportError('server→client', error, 'source') },
  )

  const stderrRelay = splice(args.handle.stderr, args.clientStderr, args.tapStderrLine, {
    endDestination: false,
    onError: (error, origin) => args.reportError('server-stderr', error, origin),
  })

  let settleDisposed: () => void = () => undefined
  const disposed = new Promise<void>((resolve) => {
    settleDisposed = resolve
  })

  return {
    dispose: () => {
      // Unblocks `relayed` for a caller still draining: a disposed pipeline
      // stops reading its source, so its own `done` can no longer settle.
      settleDisposed()
      toServer.dispose()
      toClient.dispose()
      stderrRelay.dispose()
      serverWriter.dispose()
      clientWriter.dispose()
    },
    // Deliberately excludes toServer, exactly as mode A does: the client's
    // stdin may stay open long after the child exited.
    relayed: Promise.race([
      Promise.all([toClient.done, stderrRelay.relayed]).then(() => undefined),
      disposed,
    ]),
    cancelPending: () => gate.cancelPending(),
  }
}
