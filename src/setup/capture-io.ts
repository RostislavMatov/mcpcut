/**
 * A stream pair that keeps what was written instead of printing it.
 *
 * The `setup` preflight runs a real CLI command (`policy validate`) to answer
 * one of its rows: a second copy of the loading rules would be a preflight
 * that could accept a document the real loader rejects. That command writes to
 * streams, while a check returns a value — this is the adapter between the two.
 *
 * Split from `checks.ts` for the file-size budget; it holds no policy of its
 * own beyond how a multi-line refusal is folded onto one report row.
 */

/** Minimal writable-stream shape the captured command needs. */
export interface CaptureWritable {
  write(chunk: string): unknown
}

export interface CapturedIo {
  readonly io: { readonly stdout: CaptureWritable; readonly stderr: CaptureWritable }
  /** Everything written to stderr, folded onto the single line a report row is. */
  problems(): string
}

/**
 * Captures stderr and discards stdout. The validator's own wording is kept
 * verbatim (one line per zod issue, already prefixed with its source path) and
 * the lines are folded with `; ` — the report is one row per check, and a
 * multi-line detail would break the columns.
 */
export function captureIo(): CapturedIo {
  const errChunks: string[] = []
  return {
    io: {
      stdout: { write: () => true },
      stderr: {
        write: (chunk: string) => {
          errChunks.push(chunk)
          return true
        },
      },
    },
    problems: () =>
      errChunks
        .join('')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join('; '),
  }
}
