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

export interface CapturedBothIo {
  readonly io: { readonly stdout: CaptureWritable; readonly stderr: CaptureWritable }
  /** Everything written to stdout, exactly as the command wrote it. */
  out(): string
  /** Everything written to stderr, exactly as the command wrote it. */
  err(): string
  /** True once a write past the limit was dropped from either stream. */
  truncated(): boolean
}

/**
 * Captures both streams and folds nothing.
 *
 * The console runs every action through the same `dispatch` a shell would and
 * shows the result in its output pane, so it needs the text as printed --
 * blank lines, alignment and all -- and it needs stdout as well as stderr: the
 * answer to `admin list` is on one, the refusal is on the other, and the pane
 * shows both. Splitting into lines and making them safe to draw is the
 * console's job (`src/tui/output.ts`), not this capsule's.
 */
export function captureBothIo(limitChars = Number.POSITIVE_INFINITY): CapturedBothIo {
  const out = boundedChunks(limitChars)
  const err = boundedChunks(limitChars)
  return {
    io: {
      stdout: { write: out.write },
      stderr: { write: err.write },
    },
    out: out.text,
    err: err.text,
    truncated: () => out.truncated() || err.truncated(),
  }
}

/** One stream's chunks, refusing anything past `limitChars` and remembering that it did. */
function boundedChunks(limitChars: number): {
  write(chunk: string): boolean
  text(): string
  truncated(): boolean
} {
  const chunks: string[] = []
  let length = 0
  let truncated = false
  return {
    write: (chunk: string) => {
      if (length + chunk.length > limitChars) {
        truncated = true
        return true
      }
      chunks.push(chunk)
      length += chunk.length
      return true
    },
    text: () => chunks.join(''),
    truncated: () => truncated,
  }
}
