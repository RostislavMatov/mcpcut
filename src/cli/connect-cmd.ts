import type { Readable, Writable } from 'node:stream'
import { parseArgs } from 'node:util'
import { ulid } from 'ulid'
import type { AgentRecord } from '../agents/schema.js'
import { createAgentsStore, type AgentsStore } from '../agents/store.js'
import { JOURNAL_DIR } from '../config.js'
import type { LoadPolicyOptions } from '../policy/load.js'
import type { Policy } from '../policy/schema.js'
import { EXIT_CODE_JOURNAL_FAILURE } from '../proxy/wrap.js'
import { createOrderedWriter } from '../proxy/writer.js'
import type { ServerRecord } from '../registry/schema.js'
import { createRegistryStore, type RegistryStore } from '../registry/store.js'
import type { AgentRecordReader } from '../session/agent-watch.js'
import type { SessionEndReason, SessionEndpoints } from '../session/core.js'
import { createStdioMessageSink } from '../transport/stdio-adapter.js'
import { resolveVaultRefs } from '../vault/resolve.js'
import { createVaultStore } from '../vault/store.js'
import { CONNECT_USAGE, DIAGNOSTIC_PREFIX, EXIT_CODE_REFUSED } from './connect-constants.js'
import { createMismatchGuard } from './connect-mismatch.js'
import { resolveConnectPolicy } from './connect-policy.js'
import { resolveConnectTarget } from './connect-resolve.js'
import {
  startConnectSession,
  type ConnectSessionHandle,
  type StartConnectSessionArgs,
} from './connect-session.js'
import { createReadableMessageSource } from './connect-source.js'
import {
  prepareUpstream,
  type PrepareUpstreamArgs,
  type PreparedUpstream,
} from './connect-upstream.js'

/**
 * `mcp-journal connect <server> --agent <name>` — the command an agent's own
 * client config runs (`.mcp.json`: `command: mcp-journal`, `args: [connect,
 * <server>, --agent, <name>]`, `env: MCP_AGENT_TOKEN=…`). It authenticates
 * the agent, resolves the server from the registry, opens the upstream
 * (spawned child or HTTP client) and bridges the two through one
 * `session/core.ts` session: policy gate, agent grants, live revocation
 * watch, journal.
 *
 * **stdout is the protocol channel.** Every diagnostic — refusals, policy
 * notes, upstream failures — goes to stderr; nothing but relayed JSON-RPC is
 * ever written to stdout.
 *
 * Order is the whole security story and is asserted by tests: authentication,
 * grant and registry lookup all complete BEFORE a process is spawned or a
 * request is made (`connect-resolve.ts`), and vault dereferencing fails
 * before that too (`connect-upstream.ts`). A caller who cannot authenticate
 * never causes a single byte of upstream traffic.
 */

/** Minimal writable-stream shape this command needs, so tests can inject capture objects. */
export interface ConnectCliWritable {
  write(chunk: string): unknown
}

/**
 * Only stderr: `connect`'s stdout belongs to the MCP protocol and is supplied
 * through `ConnectDeps.stdout`, not through the CLI's io. The dispatcher's
 * `CliIo` satisfies this shape structurally.
 */
export interface ConnectCliIo {
  readonly stderr: ConnectCliWritable
}

export interface ConnectDeps {
  /** Directory holding registry/agents/vault/journal state. Defaults to `JOURNAL_DIR`. */
  readonly journalDir?: string
  /** Environment: source of `MCP_AGENT_TOKEN` and of the child's allowlisted slice. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Client-facing input (the agent's requests). Defaults to `process.stdin`. */
  readonly stdin?: Readable
  /** Client-facing output (the protocol channel). Defaults to `process.stdout`. */
  readonly stdout?: Writable
  /** Where a spawned server's stderr is passed through to. Defaults to `process.stderr`. */
  readonly stderr?: Writable
  /** Working directory for a spawned server, and base for policy resolution. */
  readonly cwd?: string
  /** Injectable session id. Defaults to a fresh `ulid()`. */
  readonly sessionId?: string
  /** Injectable clock (ms since epoch). */
  readonly now?: () => number
  /**
   * Test seam for policy file reading. Deliberately NOT the full
   * `LoadPolicyOptions`: on this command the policy's location is not
   * configurable at all — it is always `<journalDir>/policy.json`
   * (`connect-policy.ts`), because everything else is agent-controlled.
   */
  readonly policyReadFile?: LoadPolicyOptions['readFile']
  readonly approvalsBaseDir?: string
  readonly inventoryStorePath?: string
  /** Revocation poll interval; defaults to the ≤5 s session constant. */
  readonly revocationPollIntervalMs?: number
  /** Names a spawned server may inherit from `env`. Defaults to `SYSTEM_ENV_ALLOWLIST`. */
  readonly systemEnvAllowlist?: readonly string[]
  /** Grace period for a child asked to exit before signals are used. */
  readonly childExitGraceMs?: number
  /** Grace period between SIGTERM and SIGKILL. */
  readonly killEscalationMs?: number
  /** Store overrides, for tests that need a fake rather than a temp directory. */
  readonly agentsStore?: Pick<AgentsStore, 'findAgentByToken' | 'getAgent'>
  readonly registryStore?: Pick<RegistryStore, 'getServer' | 'listServers'>
  /** @internal test-only seam for exercising fail-closed without an unwritable disk. */
  readonly journalCommitBatchImpl?: StartConnectSessionArgs['journalCommitBatchImpl']
}

const DEFAULT_IO: ConnectCliIo = { stderr: process.stderr }

interface ConnectFlags {
  readonly server: string
  readonly agent: string
  /**
   * `--policy`, which this command REFUSES rather than honors
   * (`connect-policy.ts`). It is still parsed so the refusal can explain
   * itself; dropping it from `options` would collapse the case into bare usage
   * text and leave the operator guessing.
   */
  readonly policy: string | undefined
  readonly failClosed: boolean
}

/** Parses argv strictly: an unknown option or a missing/extra positional is a hard error. */
function parseConnectFlags(args: readonly string[]): ConnectFlags | undefined {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: {
        agent: { type: 'string' },
        policy: { type: 'string' },
        'fail-closed': { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    })
    const server = positionals.length === 1 ? positionals[0] : undefined
    if (server === undefined || values.agent === undefined || values.agent.length === 0) {
      return undefined
    }
    return {
      server,
      agent: values.agent,
      policy: values.policy,
      failClosed: values['fail-closed'] === true,
    }
  } catch {
    return undefined
  }
}

/** The agent-facing endpoints: this process's own stdio, framed as messages. */
function buildClientEndpoints(args: {
  readonly stdin: Readable
  readonly stdout: Writable
  readonly dropBlanks: boolean
  readonly onDiagnostic: (line: string) => void
}): SessionEndpoints {
  const writer = createOrderedWriter(args.stdout, {
    onError: (error) => args.onDiagnostic(`${DIAGNOSTIC_PREFIX} client stdout: ${describe(error)}\n`),
  })
  const source = createReadableMessageSource(args.stdin, 'client', {
    ...(args.dropBlanks ? { dropBlanks: true } : {}),
    onOverflow: (byteLength) =>
      args.onDiagnostic(
        `${DIAGNOSTIC_PREFIX} dropped an oversized unterminated client fragment (${byteLength} bytes)\n`,
      ),
  })
  return { source, sink: createStdioMessageSink(writer) }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Runs one `connect` session to completion and resolves with its exit code.
 * A journal failure outranks everything (the session was cut short precisely
 * because its audit trail could not be written); a control-plane refusal
 * (revocation, protocol mismatch) outranks the upstream's own code.
 */
export async function runConnect(
  args: readonly string[],
  io: ConnectCliIo = DEFAULT_IO,
  deps: ConnectDeps = {},
): Promise<number> {
  const flags = parseConnectFlags(args)
  if (flags === undefined) {
    io.stderr.write(CONNECT_USAGE)
    return EXIT_CODE_REFUSED
  }

  const env = deps.env ?? process.env
  const journalDir = deps.journalDir
  const onDiagnostic = (line: string): void => {
    io.stderr.write(line)
  }

  const agents =
    deps.agentsStore ?? createAgentsStore(journalDir !== undefined ? { journalDir } : {})
  const registry = deps.registryStore ?? createRegistryStore(journalDir)

  const target = await resolveConnectTarget({
    serverName: flags.server,
    agentName: flags.agent,
    env,
    agents,
    registry,
  })
  if (target.status === 'refused') {
    io.stderr.write(target.refusal.message)
    return EXIT_CODE_REFUSED
  }

  // Policy comes from the operator's directory only — never from the argv,
  // cwd or environment this command was launched with (see `connect-policy.ts`).
  const policyOutcome = await resolveConnectPolicy({
    io,
    journalDir: journalDir ?? JOURNAL_DIR,
    env,
    cwd: deps.cwd ?? process.cwd(),
    ...(flags.policy !== undefined ? { explicitPath: flags.policy } : {}),
    ...(deps.policyReadFile !== undefined ? { readFile: deps.policyReadFile } : {}),
  })
  if (policyOutcome.status === 'failed') {
    return policyOutcome.exitCode
  }

  const prepared = await prepareUpstream(
    upstreamArgsOf({ deps, env, record: target.record, onDiagnostic }),
  )
  if (prepared.status === 'refused') {
    io.stderr.write(prepared.message)
    return EXIT_CODE_REFUSED
  }

  return runSession({
    deps,
    flags,
    onDiagnostic,
    agentStore: agents,
    agent: target.agent,
    policy: policyOutcome.policy,
    prepared: prepared.upstream,
  })
}

/**
 * Assembles `prepareUpstream`'s arguments, forwarding only the overrides that
 * were actually given so each keeps its own default. The vault store is built
 * here because this is the only thing that needs it: `resolveRefs` is the one
 * path a decrypted value ever travels.
 */
function upstreamArgsOf(args: {
  readonly deps: ConnectDeps
  readonly env: NodeJS.ProcessEnv
  readonly record: ServerRecord
  readonly onDiagnostic: (line: string) => void
}): PrepareUpstreamArgs {
  const { deps } = args
  const vault = createVaultStore(deps.journalDir !== undefined ? { journalDir: deps.journalDir } : {})
  return {
    record: args.record,
    processEnv: args.env,
    resolveRefs: (record) => resolveVaultRefs(record, vault.readSecretValues),
    onDiagnostic: args.onDiagnostic,
    ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
    ...(deps.stderr !== undefined ? { stderr: deps.stderr } : {}),
    ...(deps.systemEnvAllowlist !== undefined ? { systemEnvAllowlist: deps.systemEnvAllowlist } : {}),
    ...(deps.childExitGraceMs !== undefined ? { childExitGraceMs: deps.childExitGraceMs } : {}),
    ...(deps.killEscalationMs !== undefined ? { killEscalationMs: deps.killEscalationMs } : {}),
  }
}

/** The optional half of a session's arguments; same forward-only-what-was-given rule. */
function sessionOptionsOf(deps: ConnectDeps): Partial<StartConnectSessionArgs> {
  return {
    ...(deps.journalDir !== undefined ? { journalDir: deps.journalDir } : {}),
    ...(deps.approvalsBaseDir !== undefined ? { approvalsBaseDir: deps.approvalsBaseDir } : {}),
    ...(deps.inventoryStorePath !== undefined
      ? { inventoryStorePath: deps.inventoryStorePath }
      : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.revocationPollIntervalMs !== undefined
      ? { revocationPollIntervalMs: deps.revocationPollIntervalMs }
      : {}),
    ...(deps.journalCommitBatchImpl !== undefined
      ? { journalCommitBatchImpl: deps.journalCommitBatchImpl }
      : {}),
  }
}

interface ExitCodeArgs {
  readonly reason: SessionEndReason
  readonly upstreamCode: number
  readonly journalFailed: boolean
  readonly protocolMismatch: boolean
}

/**
 * A journal failure outranks everything (the session was cut short precisely
 * because its audit trail could not be written); a control-plane refusal
 * outranks the upstream's own code, which is otherwise passed through.
 */
function exitCodeOf(args: ExitCodeArgs): number {
  if (args.journalFailed) {
    return EXIT_CODE_JOURNAL_FAILURE
  }
  if (args.protocolMismatch || args.reason === 'revoked') {
    return EXIT_CODE_REFUSED
  }
  return args.upstreamCode
}

interface RunSessionArgs {
  readonly deps: ConnectDeps
  readonly flags: ConnectFlags
  readonly onDiagnostic: (line: string) => void
  readonly agentStore: AgentRecordReader
  readonly agent: AgentRecord
  readonly policy: Policy
  readonly prepared: PreparedUpstream
}

/**
 * Everything from `open()` to the first `await` runs synchronously on
 * purpose: a message source starts delivering on a later tick, so the session
 * must be wired before control leaves this stretch of code.
 */
async function runSession(args: RunSessionArgs): Promise<number> {
  const { deps, flags, onDiagnostic, prepared } = args
  const stdin = deps.stdin ?? process.stdin
  const stdout = deps.stdout ?? process.stdout

  const mismatch = createMismatchGuard(flags.server, onDiagnostic)
  const upstream = prepared.open()
  const client = buildClientEndpoints({
    stdin,
    stdout,
    dropBlanks: prepared.dropClientBlanks,
    onDiagnostic,
  })
  const clientSource = prepared.guardInitialize ? mismatch.wrap(client.source) : client.source

  const run: ConnectSessionHandle = startConnectSession({
    sessionId: deps.sessionId ?? ulid(),
    serverName: flags.server,
    agent: { record: args.agent, store: args.agentStore },
    client: { source: clientSource, sink: client.sink },
    server: upstream.endpoints,
    policy: args.policy,
    failClosed: flags.failClosed,
    onDiagnostic,
    ...sessionOptionsOf(deps),
  })
  upstream.attachStderr(run.tapStderrLine)
  mismatch.bind(run.session)
  // A child that could not be spawned never ends its stdout, so the session
  // would wait on a source that will never speak. Idempotent: on a normal
  // exit the source's own end has already closed the session.
  const session = run.session
  void upstream.gone.then(() => {
    void session.close('server-ended')
  })

  const reason: SessionEndReason = await run.session.ended
  const upstreamCode = await upstream.finish()
  upstream.dispose()
  // A source that was disposed has no listeners left, but a resumed stream
  // still holds the event loop open; `connect` must not outlive its session.
  stdin.pause()
  await run.closeJournal()

  if (reason === 'revoked') {
    onDiagnostic(`${DIAGNOSTIC_PREFIX} this agent's access was revoked; the session was ended\n`)
  }
  return exitCodeOf({
    reason,
    upstreamCode,
    journalFailed: run.hasJournalFailed(),
    protocolMismatch: mismatch.hasTripped(),
  })
}

