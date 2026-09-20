/**
 * The injection seam between the console API's HTTP layer
 * (`src/ui/console-run.ts`) and whatever actually runs a command
 * (`src/cli/console-runner.ts`, ADR-0014).
 *
 * It lives here, beside the fixed wire contract, rather than in `src/ui/**` or
 * `src/cli/**`: `src/cli/console-runner.ts` must not import `src/ui/**` at all
 * (`tests/architecture/imports.test.ts` — only `ui-cmd.ts`, `ui-wiring.ts` and
 * `ui-constants.ts` may), and `contract.ts` next to this file is the FIXED
 * wire contract shared by both sides of the network — not the place for an
 * injection type that nothing puts on the wire. This module is a third,
 * neutral leaf both `src/ui/console-run.ts` and `src/cli/console-runner.ts`
 * import without importing each other.
 */

/**
 * One run's request, as the HTTP layer hands it to the runner. `argv`/`stdin`
 * mirror `ConsoleRunRequest` from `contract.ts`; `token` is the bearer the
 * HTTP layer already verified (never re-sent on the wire), carried here only
 * so the runner can fold it into the dispatched command's environment
 * (`src/tui/session-env.ts`'s `sessionEnvOf`). It must never be echoed in a
 * frame or a stderr line — `tests/ui/console-run.test.ts` proves that with a
 * sentinel value.
 */
export interface ConsoleRunnerRequest {
  readonly argv: readonly string[]
  readonly stdin?: string
  readonly token: string
}

/**
 * A writable a runner treats exactly like the CLI's own `CliWritable`, plus
 * the optional `once('drain')` release a backpressure-aware command (the
 * console's own `export`, `src/tui/run-sink.ts`) waits on before writing more.
 */
export interface ConsoleIoWritable {
  write(chunk: string): boolean
  once?(event: 'drain', listener: () => void): unknown
}

/** The two streams one run writes to; the HTTP layer turns each write into an NDJSON frame. */
export interface ConsoleRunIo {
  readonly stdout: ConsoleIoWritable
  readonly stderr: ConsoleIoWritable
}

/** Runs one command and answers its exit code, writing to `io` as it goes. */
export type ConsoleRunner = (request: ConsoleRunnerRequest, io: ConsoleRunIo) => Promise<number>
