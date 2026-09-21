/**
 * The types the argv dispatcher speaks, in a leaf module of their own.
 *
 * They live here rather than in `src/cli.ts` so a command module can name
 * `DispatchOptions` -- or hold a `DispatchFn` handed to it from outside --
 * without importing the dispatcher that routes it: `cli.ts` imports every
 * `cli/*-cmd.ts`, so an edge back into it would drag the whole CLI into the
 * importer's module graph. Same precedent and same reason as the io shapes
 * declared in `cli/serve-constants.ts`. `cli.ts` re-exports the three names it
 * used to declare, so existing importers keep working unchanged.
 *
 * Type-only by construction: every `from` line below is an `import type`, so
 * nothing here survives compilation and the leaf stays a leaf at runtime. A
 * single value import would undo the whole point of the move.
 * `tests/architecture/imports.test.ts` pins both halves of that rule.
 *
 * Note for the empty-argv route: a bare interactive invocation is NOT exempt
 * from the broken-config gate. `--help` and `-h` are -- they explain the CLI
 * and need no data directory -- but a console opened over the wrong directory
 * is worse than a refusal that names the file and the problem.
 */
import type { AdminCliOptions } from './admin-cmd.js'
import type { AgentCliOptions } from './agent-cmd.js'
import type { ApprovalsCliOptions } from './approvals-cmd.js'
import type { BackupCommandOptions } from './backup-cmd.js'
import type { ConnectBridgeDeps } from './connect-bridge-cmd.js'
import type { ConnectDeps } from './connect-cmd.js'
import type { ExportCommandOptions } from './export-cmd.js'
import type { GroupCliOptions } from './group-cmd.js'
import type { KeygenCommandOptions } from './keygen-cmd.js'
import type { MigrateCommandOptions } from './migrate-cmd.js'
import type { PolicyCliOptions } from './policy-cmd.js'
import type { PruneCommandOptions } from './prune-cmd.js'
import type { RunQuarantineOptions } from './quarantine-cmd.js'
import type { ServeCommandOptions } from './serve-cmd.js'
import type { ServerCliOptions } from './server-cmd.js'
import type { ServiceCliOptions } from './service-cmd.js'
import type { SetupCliOptions } from './setup-cmd.js'
import type { TuiCommandOptions } from './tui-cmd.js'
import type { UiCommandOptions } from './ui-cmd.js'
import type { VaultCmdDeps } from './vault-cmd.js'
import type { VerifyCommandOptions } from './verify-cmd.js'
import type { WrapCommandOptions } from './wrap-cmd.js'
import type { DataDirResolution } from '../setup/data-dir.js'

/** Minimal writable-stream shape the dispatcher and its subcommands need. */
export interface CliWritable {
  write(chunk: string): unknown
}

export interface CliIo {
  readonly stdout: CliWritable
  readonly stderr: CliWritable
}

/** Test-only seams for each subcommand, so `tests/cli/dispatch.test.ts` can isolate every command from real disk state. */
export interface DispatchOptions {
  /** Journal directory override for `sessions`/`show`. Defaults to JOURNAL_DIR. */
  readonly journalDir?: string
  readonly wrap?: WrapCommandOptions
  readonly policy?: PolicyCliOptions
  readonly quarantine?: RunQuarantineOptions
  readonly approvals?: ApprovalsCliOptions
  readonly server?: ServerCliOptions
  readonly vault?: VaultCmdDeps
  readonly agent?: AgentCliOptions
  readonly group?: GroupCliOptions
  readonly connect?: ConnectDeps
  /** Seams for the REMOTE form, `connect --url` (ADR-0015): env, stdio, the HTTP client. */
  readonly connectBridge?: ConnectBridgeDeps
  readonly serve?: ServeCommandOptions
  readonly ui?: UiCommandOptions
  readonly admin?: AdminCliOptions
  readonly migrate?: MigrateCommandOptions
  readonly export?: ExportCommandOptions
  readonly backup?: BackupCommandOptions
  readonly verify?: VerifyCommandOptions
  readonly prune?: PruneCommandOptions
  readonly keygen?: KeygenCommandOptions
  readonly services?: ServiceCliOptions
  readonly setup?: SetupCliOptions
  /** Seams for the console: its terminal, its dispatcher, its install config. */
  readonly tui?: TuiCommandOptions
  /** Data-directory resolution to judge. Defaults to the process-wide one. */
  readonly install?: DataDirResolution
}

/** The dispatcher as the console sees it: the same `dispatch`, arriving from outside. */
export type DispatchFn = (
  argv: readonly string[],
  io: CliIo,
  opts?: DispatchOptions,
) => Promise<number>
