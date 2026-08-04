import type { Readable } from 'node:stream'
import { createFrameSplitter, type Frame, type Terminator } from '../protocol/split.js'
import type { OrderedWriter } from './writer.js'

/**
 * Transport half of mode B: frame -> verdict -> bytes.
 *
 * This module deals only in bytes and frames (`protocol/split.ts`). It
 * must never import or know about JSON-RPC or MCP semantics — the verdict
 * it acts on is opaque (`forward | drop | emit(bytes)`), produced by an
 * injected `gate` callback that lives in the replaceable semantic layer
 * (`proxy/gate.ts`). See the architectural invariant in CLAUDE.md and
 * `tests/architecture/imports.test.ts`, which enforces it mechanically.
 *
 * Ownership and backpressure discipline mirror `proxy/splice.ts`: a
 * pipeline owns exactly the listeners it installs on `source` and removes
 * them again in `dispose()`.
 *
 * Byte-identity scope: a source that ends mid-frame (no final terminator)
 * has its retained tail flushed through the same gate/forward path on
 * `'end'`, so the relayed bytes equal the source bytes even then. A source
 * that never ends and is only `dispose()`d keeps its tail unforwarded —
 * there is nothing left to relay it to.
 */

/** The gate's decision for one non-blank frame. */
export type Verdict =
  | { readonly action: 'forward' }
  | { readonly action: 'drop' }
  | { readonly action: 'emit'; readonly bytes: Buffer }

/**
 * Decides what happens to one frame. May answer synchronously or
 * asynchronously; an asynchronous answer never blocks later frames from
 * being read, gated, and (if resolved first) written — head-of-line
 * blocking is deliberately rejected, see the plan's "Порядок" decision.
 */
export type GateFn = (frame: Frame) => Verdict | Promise<Verdict>

export interface PipelineOptions {
  /**
   * Called for source stream errors and for a gate that throws or rejects
   * (the latter is treated as a fail-closed `drop`). A stream error must
   * never surface as an uncaught exception, so this is the only place
   * either is reported. Defaults to writing one line to `process.stderr`.
   */
  onError?: (error: unknown) => void
  /**
   * Called once the source has ended and every verdict it produced has
   * settled (and been acted on). The destination is deliberately left
   * open: lifecycle (ending it, closing the child) belongs to the wrap
   * layer that owns both directions, not to one pipeline.
   */
  onEnd?: () => void
  /**
   * Number of frames with an in-flight gate evaluation and/or write above
   * which the source is paused; reading resumes once the count drops back
   * to or below this line. Defaults to HIGH_WATER_PENDING_FRAMES.
   */
  highWaterMark?: number
  /**
   * Maximum bytes an unterminated line may accumulate before the splitter
   * force-emits it as an `'overflow'` fragment. Forwarded to
   * `createFrameSplitter`; mainly a test seam. Defaults to the splitter's own
   * default (`MAX_LINE_BUFFER_BYTES`).
   */
  maxBufferBytes?: number
}

export interface PipelineHandle {
  /**
   * Removes exactly the listeners this pipeline installed on `source` and
   * stops reading. A verdict that settles after `dispose()` is ignored:
   * it is never written to the destination.
   */
  dispose(): void
  /**
   * Resolves once the source has ended (or errored) and every verdict it
   * produced has settled. Never resolves if the source never ends and
   * `dispose()` is not called.
   */
  readonly done: Promise<void>
}

/** Default ceiling on in-flight (gate + write) frames before pausing the source. */
const HIGH_WATER_PENDING_FRAMES = 64

const TERMINATOR_BYTES: Readonly<Record<Terminator, Buffer>> = {
  '\n': Buffer.from('\n'),
  '\r\n': Buffer.from('\r\n'),
  none: Buffer.alloc(0),
}

/** Reproduces a frame's original wire bytes: content followed by its original terminator. */
function reattachTerminator(frame: Frame): Buffer {
  return Buffer.concat([frame.bytes, TERMINATOR_BYTES[frame.terminator]])
}

function defaultOnError(error: unknown): void {
  process.stderr.write(`[pipeline] ${describeError(error)}\n`)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One installed listener, paired with the removal of exactly that listener. */
interface Registration {
  readonly remove: () => void
}

function register<Args extends unknown[]>(
  emitter: NodeJS.EventEmitter,
  event: string,
  listener: (...args: Args) => void,
): Registration {
  emitter.on(event, listener)
  return { remove: () => emitter.removeListener(event, listener) }
}

/**
 * Relays `source` through `gate` to `writer`, one frame at a time.
 *
 * Blank frames, and frames the gate resolves to `'forward'`, are written
 * with their original bytes and original terminator reattached — so a
 * stream in which nothing is gated comes out of `writer` byte-for-byte
 * identical to the input. `'emit'` writes the gate's replacement bytes
 * verbatim (the gate is responsible for its own terminator). `'drop'`
 * writes nothing.
 */
export function startPipeline(
  source: Readable,
  writer: OrderedWriter,
  gate: GateFn,
  opts: PipelineOptions = {},
): PipelineHandle {
  const onError = opts.onError ?? defaultOnError
  const highWaterMark = opts.highWaterMark ?? HIGH_WATER_PENDING_FRAMES
  const splitter = createFrameSplitter(
    opts.maxBufferBytes !== undefined ? { maxBufferBytes: opts.maxBufferBytes } : {},
  )

  let isDisposed = false
  let isSourceEnded = false
  let isFinished = false
  let pendingCount = 0
  let settleDone: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    settleDone = resolve
  })

  function checkFinished(): void {
    if (isFinished || !isSourceEnded || pendingCount !== 0) {
      return
    }
    isFinished = true
    opts.onEnd?.()
    settleDone()
  }

  function updateBackpressure(): void {
    if (isDisposed) {
      return
    }
    if (pendingCount > highWaterMark) {
      source.pause()
    } else {
      source.resume()
    }
  }

  /** Tracks one frame's outstanding work (gate evaluation + resulting write). */
  function trackPending(work: Promise<void>): void {
    pendingCount += 1
    void work.finally(() => {
      pendingCount -= 1
      updateBackpressure()
      checkFinished()
    })
  }

  function applyVerdict(frame: Frame, verdict: Verdict): Promise<void> {
    if (isDisposed) {
      return Promise.resolve()
    }
    if (verdict.action === 'forward') {
      return writer.writeMessage(reattachTerminator(frame))
    }
    if (verdict.action === 'emit') {
      return writer.writeMessage(verdict.bytes)
    }
    return Promise.resolve()
  }

  function isPromiseVerdict(outcome: Verdict | Promise<Verdict>): outcome is Promise<Verdict> {
    return typeof (outcome as Partial<Promise<Verdict>>).then === 'function'
  }

  function processFrame(frame: Frame): void {
    if (frame.reason === 'overflow') {
      // Fail closed: an 'overflow' fragment is an unterminated slice of an
      // unfinished line. Reassembly downstream would splice it back together
      // and execute it, bypassing the gate entirely (C1) — so it is dropped,
      // never forwarded and never gated, and the drop is reported.
      onError(
        new Error(
          `dropped an oversized unterminated frame (${frame.bytes.length} bytes) ` +
            'exceeding the line buffer limit; not forwarding to the destination',
        ),
      )
      return
    }

    if (frame.isBlank) {
      trackPending(writer.writeMessage(reattachTerminator(frame)))
      return
    }

    let outcome: Verdict | Promise<Verdict>
    try {
      outcome = gate(frame)
    } catch (error) {
      // Fail-closed, and nothing to await: the frame is already fully
      // handled (dropped) by the time processFrame returns.
      onError(error)
      return
    }

    if (isPromiseVerdict(outcome)) {
      // Asynchronous verdict: never block later frames from being read,
      // gated, and (if they resolve first) written — see the module doc.
      trackPending(
        outcome.then(
          (verdict) => applyVerdict(frame, verdict),
          (error: unknown) => {
            onError(error)
          },
        ),
      )
      return
    }

    // Synchronous verdict: act inline, in the same synchronous pass over
    // this chunk's frames, so its write is issued to `writer` in the same
    // relative order as any other frame resolved synchronously alongside
    // it (blank frames, or another frame whose gate also answered inline).
    trackPending(applyVerdict(frame, outcome))
  }

  function handleChunk(chunk: Buffer): void {
    for (const frame of splitter.push(chunk)) {
      processFrame(frame)
    }
    updateBackpressure()
  }

  function handleSourceEnd(): void {
    // A source that died mid-line still produced those bytes, and the
    // destination must see them: flush the splitter's unterminated tail
    // through the very same gate/forward path before finishing, so mode B
    // never eats the final partial output of a crashed peer.
    for (const frame of splitter.flush()) {
      processFrame(frame)
    }
    isSourceEnded = true
    checkFinished()
  }

  function stopReading(): void {
    for (const registration of registrations) {
      registration.remove()
    }
    source.pause()
  }

  function handleSourceError(error: unknown): void {
    if (isDisposed) {
      return
    }
    stopReading()
    onError(error)
    isSourceEnded = true
    checkFinished()
  }

  const registrations: readonly Registration[] = [
    register(source, 'data', handleChunk),
    register(source, 'end', handleSourceEnd),
    register(source, 'error', handleSourceError),
  ]
  // Explicit, because attaching 'data' only auto-resumes a stream that was
  // never explicitly paused — including one a previous pipeline disposed of.
  source.resume()

  return {
    dispose(): void {
      if (isDisposed) {
        return
      }
      isDisposed = true
      stopReading()
    },
    done,
  }
}
