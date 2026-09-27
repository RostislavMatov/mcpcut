import { z } from 'zod'
import { INITIAL_DEMUX_STATE, MalformedStreamError, demuxChunk, isDemuxComplete, type DockerStream } from './docker-demux.js'
import { DockerApiError, expectStatus, parseAnswer, type Wire, type WireRequest } from './docker-wire.js'

/**
 * `docker exec` over the Engine API (plan `tenant-orchestrator`, Task 3), in
 * three calls:
 *
 *  1. `POST /containers/{id}/exec` — attached stdout/stderr, no stdin, no TTY;
 *  2. `POST /exec/{id}/start` `{Detach:false, Tty:false}` — sent WITHOUT
 *     `Upgrade: tcp`. moby then still takes the connection over, but writes
 *     a plain `HTTP/1.1 200 OK` head and the output until it closes the
 *     connection (verified against `daemon/server/router/container/exec.go`:
 *     the `101 UPGRADED` head is written only when the request carries
 *     `Upgrade`). Node's parser reads a close-delimited body natively, so no
 *     hijack is needed. Without a TTY the output is multiplexed (`stdcopy`)
 *     whatever the Content-Type says; `docker-demux.ts` splits it;
 *  3. `GET /exec/{id}/json` for `ExitCode` — retried briefly, since the
 *     daemon may still report `Running` just after the stream closes.
 *
 * Each stream is kept up to 64 KiB and marked truncated past it; the rest is
 * drained and dropped, bounded by the call's deadline. The output — which
 * holds an owner token when the provisioner runs `admin add --json` — never
 * reaches an error message.
 */

export const EXEC_OUTPUT_CAP_BYTES = 64 * 1024
const EXIT_CODE_ATTEMPTS = 20
const EXIT_CODE_RETRY_MS = 25

export interface ExecOptions {
  /** `user`, `user:group`, `uid` or `uid:gid`. */
  readonly user?: string
  readonly env?: Readonly<Record<string, string>>
  /** Deadline for the output stream (the command's run time); defaults to the client's. */
  readonly timeoutMs?: number
}

export interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly truncated: Readonly<Record<DockerStream, boolean>>
}

const ExecCreatedAnswer = z.object({ Id: z.string().regex(/^[A-Za-z0-9]{1,128}$/) })
const ExecInspectAnswer = z.object({ Running: z.boolean(), ExitCode: z.number().int().nullable() })

/** `container` is a validated, encoded path segment; `argv` and `options` are validated by the client. */
export async function runExec(wire: Wire, container: string, argv: readonly string[], options: ExecOptions): Promise<ExecResult> {
  const env = Object.entries(options.env ?? {}).map(([name, value]) => `${name}=${value}`)
  const request: WireRequest = {
    operation: 'exec create',
    method: 'POST',
    path: `/containers/${container}/exec`,
    body: {
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: argv,
      ...(options.user === undefined ? {} : { User: options.user }),
      ...(env.length === 0 ? {} : { Env: env }),
    },
    redact: Object.values(options.env ?? {}),
  }
  const created = await wire.send(request)
  expectStatus(created, request, [201])
  const execId = parseAnswer(created, request.operation, ExecCreatedAnswer).Id
  const output = await readOutput(wire, execId, options.timeoutMs)
  const exitCode = await awaitExitCode(wire, execId)
  return { exitCode, ...output }
}

interface CappedSink {
  push(data: Buffer): void
  text(): string
  truncated(): boolean
}

/** Keeps the first `EXEC_OUTPUT_CAP_BYTES` of one stream. Owned by a single exec call. */
function cappedSink(): CappedSink {
  const kept: Buffer[] = []
  let size = 0
  let isTruncated = false
  return {
    push: (data) => {
      const room = EXEC_OUTPUT_CAP_BYTES - size
      if (data.length > room) isTruncated = true
      if (room <= 0 || data.length === 0) return
      const piece = data.subarray(0, room)
      kept.push(Buffer.from(piece))
      size += piece.length
    },
    text: () => Buffer.concat(kept).toString('utf8'),
    truncated: () => isTruncated,
  }
}

async function readOutput(wire: Wire, execId: string, timeoutMs: number | undefined): Promise<Omit<ExecResult, 'exitCode'>> {
  const operation = 'exec start'
  const sinks: Readonly<Record<DockerStream, CappedSink>> = { stdout: cappedSink(), stderr: cappedSink() }
  let demux = INITIAL_DEMUX_STATE
  const onChunk = (chunk: Buffer): void => {
    try {
      const step = demuxChunk(demux, chunk)
      demux = step.state
      for (const piece of step.pieces) sinks[piece.stream].push(piece.data)
    } catch (error: unknown) {
      if (error instanceof MalformedStreamError) throw new DockerApiError('bad-response', `${operation}: ${error.message}`)
      throw error
    }
  }
  const request: WireRequest = {
    operation,
    method: 'POST',
    path: `/exec/${execId}/start`,
    body: { Detach: false, Tty: false },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
  await wire.stream(request, onChunk)
  if (!isDemuxComplete(demux)) throw new DockerApiError('bad-response', `${operation}: the output stream ended mid-frame`)
  return {
    stdout: sinks.stdout.text(),
    stderr: sinks.stderr.text(),
    truncated: { stdout: sinks.stdout.truncated(), stderr: sinks.stderr.truncated() },
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function awaitExitCode(wire: Wire, execId: string): Promise<number> {
  const request: WireRequest = { operation: 'exec inspect', method: 'GET', path: `/exec/${execId}/json` }
  for (let attempt = 1; attempt <= EXIT_CODE_ATTEMPTS; attempt += 1) {
    const response = await wire.send(request)
    expectStatus(response, request, [200])
    const answer = parseAnswer(response, request.operation, ExecInspectAnswer)
    if (!answer.Running && answer.ExitCode !== null) return answer.ExitCode
    if (attempt < EXIT_CODE_ATTEMPTS) await pause(EXIT_CODE_RETRY_MS)
  }
  throw new DockerApiError('bad-response', `${request.operation}: no exit code after ${EXIT_CODE_ATTEMPTS} checks`)
}
