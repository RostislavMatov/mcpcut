import { Writable } from 'node:stream'

/**
 * The least a diagnostics target has to offer. `process.stderr` and any
 * `Writable` qualify; so do the bare `{ write }` capture objects the CLI
 * tests inject — those simply cannot announce a failure.
 */
export interface DiagnosticsTarget {
  write(chunk: string): unknown
  on?(event: 'error', listener: (error: unknown) => void): unknown
}

/**
 * Wraps a diagnostics stream so it goes quiet the moment its target fails,
 * instead of reporting the failure into the very stream that failed.
 *
 * The loop this closes (2026-08-25): a `connect` whose client process had
 * died was left with a broken stderr pipe. The splice relaying the server's
 * stderr into it got EPIPE, reported it through `onDiagnostic` — a write to
 * that same stderr — which failed with EPIPE, which was reported again.
 * Node's stdio streams cannot be destroyed (`destroy` is a no-op on them),
 * so nothing ever refused the next write; each failure was re-emitted on
 * `nextTick`, the event loop never reached its poll phase, SIGTERM was never
 * delivered, and the orphan pinned a core for three days.
 *
 * Diagnostics are best-effort by nature: once the target has said it is gone
 * (an `'error'` event, or a synchronous throw from `write`) every later line
 * is dropped. The guard itself never emits `'error'`.
 *
 * Two consequences worth knowing. The guard subscribes to the target's
 * `'error'` at construction, so build it BEFORE anything splices into the
 * same stream: listeners run in registration order, and the flag then flips
 * before any reporter writes. (A reversed order still terminates — one extra
 * bounce, since every listener of one emission runs in the same tick.) And a
 * broken stderr no longer crashes the process as an unhandled `'error'`: the
 * proxy degrades to silent diagnostics and keeps relaying — deliberate, the
 * alternative being the hang above.
 */
export function guardDiagnostics(target: DiagnosticsTarget): Writable {
  let isTargetGone = false
  target.on?.('error', () => {
    isTargetGone = true
  })
  return new Writable({
    decodeStrings: false,
    write(chunk: string | Buffer, _encoding, callback) {
      if (!isTargetGone) {
        try {
          target.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
        } catch {
          isTargetGone = true
        }
      }
      callback()
    },
  })
}
