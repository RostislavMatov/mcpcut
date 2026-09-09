import { OUTPUT_CUT_NOTE } from './constants.js'
import type { RunRequest } from './model.js'
import type { RunResult } from './output.js'
import type { RunSink } from './run-sink.js'

/**
 * A finished run as the output pane takes it (mcpcut phase 4, task 8; split
 * out of `runtime-effects.ts` for the file-size budget).
 *
 * One rule shapes everything here: a thing the operator must read goes into
 * the text of the run, not into a field of its own. The failure that stood in
 * for an exit code, the note that the capture was cut, the write that could
 * not be flushed to the export file — all of them are appended to stderr,
 * because the pane draws what a command wrote and the operator reads that.
 */

/** What a run reports when the command itself never got to answer. */
export const FAILED_RUN_EXIT_CODE = 1

/** An exit code, plus the message of the throw that stood in for one. */
export interface DispatchOutcome {
  readonly code: number
  readonly failure?: string
}

/** The outcome with a failure that arrived after the command answered folded in. */
export function withFailure(
  outcome: DispatchOutcome,
  failure: string | undefined,
): DispatchOutcome {
  if (failure === undefined) return outcome
  // A file that could not be closed makes the run failed however the command
  // exited: an export whose last write never reached the disk is not a
  // success, and reporting the command's own 0 would say it was.
  return {
    code: FAILED_RUN_EXIT_CODE,
    failure: outcome.failure === undefined ? failure : `${outcome.failure}\n${failure}`,
  }
}

/** The run a command never got to make: nothing was dispatched, and this is why. */
export function failedRun(request: RunRequest, failure: string): RunResult {
  return {
    argv: request.argv,
    display: request.display,
    exitCode: FAILED_RUN_EXIT_CODE,
    stdout: '',
    stderr: appended('', failure),
  }
}

/** A dispatched run, its sink read back, ready for the output pane. */
export function runResultOf(
  request: RunRequest,
  sink: RunSink,
  outcome: DispatchOutcome,
): RunResult {
  const stderrWithFailure =
    outcome.failure === undefined ? sink.err() : appended(sink.err(), outcome.failure)
  const stderr = sink.truncated() ? appended(stderrWithFailure, OUTPUT_CUT_NOTE) : stderrWithFailure
  return {
    argv: request.argv,
    display: request.display,
    exitCode: outcome.code,
    stdout: sink.out(),
    stderr,
  }
}

/** The failure on its own line, whatever the command had already written. */
function appended(stderr: string, failure: string): string {
  const separator = stderr === '' || stderr.endsWith('\n') ? '' : '\n'
  return `${stderr}${separator}${failure}\n`
}
