import { parseArgs } from 'node:util'
import { JOURNAL_DIR } from '../config.js'
import { replaceControlChars } from '../journal/format.js'
import { loadPolicy, type LoadPolicyOptions } from '../policy/load.js'
import type { PolicyProvider } from '../policy/reload.js'
import { resolvePolicySource } from '../policy/source.js'
import { autoServerName } from '../proxy/wire-policy.js'
import { SpawnServerError } from '../proxy/spawn.js'
import { runWrap, type RunWrapOptions } from '../proxy/wrap.js'
import { preflightDatabases } from '../store/preflight.js'
import { adminStoreEmptiness } from './admin-token.js'
import { cliCommand, heldCallNotice, noPolicyNotice, sessionJournaledNotice, spawnFailureHint, wrapExampleLine } from './next-step.js'
import { formatPolicyLoadErrors } from './policy-load-errors.js'
import { createReloadingPolicy } from './policy-reload.js'

/**
 * `wrap [options] -- <cmd> [args...]`: parses the options that come *before*
 * the `--` separator, resolves the policy they name (if any), and runs the
 * wrapped server. Split out of `cli.ts` so the dispatcher stays a thin
 * router (see `cli.ts`'s module doc comment) -- this is the one command with
 * real decision logic (mode A vs. mode B, fail-closed-on-broken-policy).
 */

/** Minimal writable-stream shape this command needs, so tests can inject plain capture objects. */
export interface WrapCliWritable {
  write(chunk: string): unknown
}

export interface WrapCliIo {
  readonly stderr: WrapCliWritable
}

/**
 * Options threaded through to the two things this command calls, kept
 * separate (rather than flattened) because `RunWrapOptions` and
 * `LoadPolicyOptions` both happen to have unrelated `cwd`-shaped concerns
 * (spawn cwd vs. policy-resolution cwd) -- flattening them would be
 * confusing at the call site.
 */
export interface WrapCommandOptions {
  /** Forwarded to `runWrap` unchanged; lets tests inject fake stdio, a fixed session id, or an injectable clock. */
  readonly runWrap?: Omit<RunWrapOptions, 'policy' | 'serverName' | 'failClosed'>
  /** Forwarded to `loadPolicy` unchanged (minus `explicitPath`, which comes from `--policy`). */
  readonly loadPolicy?: Omit<LoadPolicyOptions, 'explicitPath'>
  /** The platform a spawn failure's hint is written for. Defaults to `process.platform`; a seam for tests. */
  readonly platform?: NodeJS.Platform
}

const DEFAULT_IO: WrapCliIo = { stderr: process.stderr }

/**
 * True while the installation has no admin: the person at the client may
 * approve. Exactly `approvals approve`'s rule without a token — `no-install`
 * does not count, as there (a client config missing MCPCUT_DATA_DIR must not
 * open what "nobody exists" opens; the queue's own write creates the
 * database before anything is asked).
 */
async function hasNoAdmins(journalDir: string | undefined): Promise<boolean> {
  const emptiness = await adminStoreEmptiness(journalDir !== undefined ? { journalDir } : {})
  return emptiness.kind === 'empty'
}

/** The usage block; its example names the directory the operator is in, so it can be pasted as is. */
function wrapUsage(cwd: string): string {
  return `Usage:
  mcpcut wrap [--server <name>] [--policy <path>] [--no-policy] [--fail-closed] -- <cmd> [args...]
                                         Run a wrapped MCP server, journaling all traffic
${wrapExampleLine(cwd)}`
}

/**
 * Splits `wrap [options] -- <cmd> [args...]`, resolves the policy the
 * options name (if any), and runs the wrapped server to completion. A broken
 * policy fails fast here, before anything is spawned: falling back to
 * allow-all is never acceptable (see the M2 plan's "Принятые решения").
 */
export async function runWrapCommand(
  wrapArgs: readonly string[],
  io: WrapCliIo = DEFAULT_IO,
  opts: WrapCommandOptions = {},
): Promise<number> {
  const usage = wrapUsage(opts.loadPolicy?.cwd ?? process.cwd())
  const dashIndex = wrapArgs.indexOf('--')
  if (dashIndex === -1) {
    io.stderr.write(`Missing "-- <cmd>" in wrap command.\n\n${usage}`)
    return 1
  }

  const childCommand = wrapArgs[dashIndex + 1]
  if (childCommand === undefined) {
    io.stderr.write(`Missing "-- <cmd>" in wrap command.\n\n${usage}`)
    return 1
  }
  const childArgs = wrapArgs.slice(dashIndex + 2)

  const flags = parseWrapFlags(wrapArgs.slice(0, dashIndex))
  if (flags === undefined) {
    io.stderr.write(`Unknown option(s) in wrap command.\n\n${usage}`)
    return 1
  }

  // Before the policy is read and long before anything is spawned: a session
  // whose journal cannot be trusted must never start (M4.5 wave 5).
  if (!(await preflightDatabases(opts.runWrap?.dir ?? JOURNAL_DIR, io.stderr))) {
    return 1
  }

  const policyOutcome = await resolvePolicy(flags, io, opts.loadPolicy ?? {})
  if (policyOutcome.exitCode !== undefined) {
    return policyOutcome.exitCode
  }

  if (flags.server === undefined) {
    // The hash is the key of this server's rules and approved tools, so it
    // stays; the line only says what the approval queue will show (owner
    // decision 2026-09-25, first-minute friction).
    io.stderr.write(`wrap: server name is ${autoServerName(childCommand, childArgs)}; pass --server <name> for a readable one\n`)
  }

  try {
    return await runWrap(childCommand, childArgs, {
      // A held call is named on stderr with the command that releases it: the
      // Stop step used to wait out its whole window in silence (0.2.3).
      approvalNotice: heldCallNotice,
      // P2: a held call is also asked in the client while nobody but its
      // user can approve — no admins yet, as `approvals approve` needs no
      // token only then.
      askClient: { mayAsk: () => hasNoAdmins(opts.runWrap?.dir), command: cliCommand() },
      sessionEndNotice: sessionJournaledNotice,
      ...opts.runWrap,
      ...(flags.server !== undefined ? { serverName: flags.server } : {}),
      ...(flags.failClosed ? { failClosed: true } : {}),
      ...(policyOutcome.policy !== undefined ? { policy: policyOutcome.policy } : {}),
    })
  } catch (error: unknown) {
    if (!(error instanceof SpawnServerError)) throw error
    // The server never started: say why and what to type instead (0.2.4 on
    // Windows answered the README command with a bare `spawn npx ENOENT`).
    io.stderr.write(`${replaceControlChars(error.message)}\n${spawnFailureHint(error, opts.platform)}`)
    return 1
  }
}

interface WrapFlags {
  readonly server: string | undefined
  readonly policy: string | undefined
  readonly noPolicy: boolean
  readonly failClosed: boolean
}

/** Parses the pre-`--` tokens strictly: an unrecognized option is a hard error, not silently ignored. */
function parseWrapFlags(preArgs: readonly string[]): WrapFlags | undefined {
  try {
    const { values } = parseArgs({
      args: [...preArgs],
      options: {
        server: { type: 'string' },
        policy: { type: 'string' },
        'no-policy': { type: 'boolean', default: false },
        'fail-closed': { type: 'boolean', default: false },
      },
      allowPositionals: false,
      strict: true,
    })
    return {
      server: values.server,
      policy: values.policy,
      noPolicy: values['no-policy'] === true,
      failClosed: values['fail-closed'] === true,
    }
  } catch {
    return undefined
  }
}

interface PolicyOutcome {
  /** Present only when a policy was actually loaded (mode B); hot-reloads from its file. */
  readonly policy?: PolicyProvider
  /** Present only when resolution failed and the caller must stop before spawning anything. */
  readonly exitCode?: number
}

/**
 * `--no-policy` skips loading entirely (mode A), regardless of any `--policy`
 * also given. Otherwise the source is resolved through `resolvePolicySource`
 * (`wrap` is an `operator-launched` entry point — ADR-0005 — so the full
 * four-source order applies unchanged; going through the rule module makes
 * that a decision on record, symmetric with `serve`), then: `status: 'error'`
 * (broken/missing-and-named file) is a hard stop -- a broken policy must
 * never fall back to allow-all; `'disabled'` (no file found anywhere) falls
 * back to mode A with one stderr note; `'loaded'` selects mode B.
 */
async function resolvePolicy(
  flags: WrapFlags,
  io: WrapCliIo,
  loadPolicyOpts: Omit<LoadPolicyOptions, 'explicitPath'>,
): Promise<PolicyOutcome> {
  if (flags.noPolicy) {
    return {}
  }

  const source = await resolvePolicySource({
    entryPoint: 'wrap',
    ...(loadPolicyOpts.journalDir !== undefined ? { journalDir: loadPolicyOpts.journalDir } : {}),
    ...(loadPolicyOpts.env !== undefined ? { env: loadPolicyOpts.env } : {}),
    ...(loadPolicyOpts.cwd !== undefined ? { cwd: loadPolicyOpts.cwd } : {}),
    ...(loadPolicyOpts.readFile !== undefined ? { readFile: loadPolicyOpts.readFile } : {}),
    ...(flags.policy !== undefined ? { explicitPath: flags.policy } : {}),
  })

  if (source.status === 'refused') {
    // Unreachable for an operator-launched entry point; handled rather than
    // asserted so a future trust-class change cannot run a wrapped server on
    // a policy the rule module just refused.
    io.stderr.write(`wrap: policy source refused (${source.reason})\n`)
    return { exitCode: 1 }
  }

  const result = await loadPolicy(source.loadOptions)

  if (result.status === 'error') {
    io.stderr.write(formatPolicyLoadErrors(result))
    return { exitCode: 1 }
  }
  if (result.status === 'disabled') {
    io.stderr.write(noPolicyNotice(source.candidates[0]?.path))
    return {}
  }
  io.stderr.write(`policy: loaded from ${result.sourcePath}\n`)
  return {
    policy: createReloadingPolicy({
      initial: result.policy,
      sourcePath: result.sourcePath,
      loadOptions: source.loadOptions,
      candidates: source.candidates,
      stderr: io.stderr,
    }),
  }
}
