import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { runExec, type ExecOptions, type ExecResult } from './docker-exec.js'
import type {
  ContainerInfo,
  ContainerSpec,
  ContainerSummary,
  Labels,
  ListContainersFilter,
  NetworkInfo,
  NetworkOptions,
  VolumeInfo,
} from './docker-types.js'
import { createWire, expectStatus, parseAnswer, type WireRequest, type WireResponse } from './docker-wire.js'

/**
 * The provisioner's Docker Engine API client (plan `tenant-orchestrator`,
 * Task 3, decision O1): the only code in the hub that talks to
 * `/var/run/docker.sock`, and it can say only what is below — no generic
 * "send this request" door. Every name is checked against Docker's own name
 * rule before it becomes a path segment, so `../images` or `a/b` never
 * reaches the daemon; argv and env are checked before an exec is created.
 *
 * A 404 surfaces as `DockerApiError.notFound`, so callers can make removal
 * idempotent. Errors carry no request body (env) and no exec output (token):
 * see `docker-wire.ts` and `docker-exec.ts`.
 */

export { DockerApiError, DOCKER_MAX_RESPONSE_BYTES, DOCKER_MESSAGE_MAX_CHARS, type DockerFailure } from './docker-wire.js'
export { EXEC_OUTPUT_CAP_BYTES, type ExecOptions, type ExecResult } from './docker-exec.js'
export type * from './docker-types.js'

export const DOCKER_API_VERSION = 'v1.45'
/** Per request, covering connect, headers and the whole body. */
export const DOCKER_TIMEOUT_MS = 30_000

/** Docker's rule for container, network and volume names; ids match it too. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/
const API_VERSION_PATTERN = /^v\d{1,2}\.\d{1,3}$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63})?$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const NUL = '\u0000'
const MAX_STOP_TIMEOUT_S = 600
const STOP_ANSWER_MARGIN_S = 10
const MS_PER_S = 1000
/** Generous bounds on a network driver option (e.g. `com.docker.network.bridge.name`); Docker itself does not cap these. */
const MAX_OPTION_KEY_LENGTH = 255
const MAX_OPTION_VALUE_LENGTH = 4096

export interface DockerClientOptions {
  /** Absolute path of the daemon's socket, e.g. `/var/run/docker.sock`. */
  readonly socketPath: string
  readonly apiVersion?: string
  readonly timeoutMs?: number
}

export interface CreatedContainer {
  readonly id: string
  readonly warnings: readonly string[]
}

export interface DockerClient {
  /** `options` are the network driver's own options (`Options` in Docker's body), e.g. a fixed bridge interface name. */
  createNetwork(name: string, labels: Labels, options?: NetworkOptions): Promise<{ readonly id: string }>
  connectNetwork(network: string, container: string): Promise<void>
  disconnectNetwork(network: string, container: string): Promise<void>
  removeNetwork(name: string): Promise<void>
  /** The network's name and labels; a missing network is `DockerApiError.notFound`. */
  inspectNetwork(name: string): Promise<NetworkInfo>
  createVolume(name: string, labels: Labels): Promise<VolumeInfo>
  removeVolume(name: string): Promise<void>
  inspectVolume(name: string): Promise<VolumeInfo>
  /** The volume's size from `/system/df`, or undefined when Docker does not know it. */
  volumeSize(name: string): Promise<number | undefined>
  createContainer(name: string, spec: ContainerSpec): Promise<CreatedContainer>
  /** Already running (304) is success. */
  startContainer(id: string): Promise<void>
  /** Already stopped (304) is success. */
  stopContainer(id: string, timeoutS: number): Promise<void>
  removeContainer(id: string, options: { readonly force: boolean }): Promise<void>
  inspectContainer(id: string): Promise<ContainerInfo>
  /** Containers in every state whose labels match. */
  listContainers(filter: ListContainersFilter): Promise<readonly ContainerSummary[]>
  /** Runs `argv` without a shell. A non-zero exit code is a result, not an error. */
  exec(container: string, argv: readonly string[], options: ExecOptions): Promise<ExecResult>
  close(): void
}

const LabelsAnswer = z
  .record(z.string(), z.string())
  .nullish()
  .transform((labels): Labels => labels ?? {})
const IdAnswer = z.object({ Id: z.string().regex(NAME_PATTERN) })
const ContainerCreatedAnswer = IdAnswer.extend({ Warnings: z.array(z.string()).nullish() })
const NetworkAnswer = z.object({ Name: z.string(), Labels: LabelsAnswer })
const VolumeAnswer = z.object({ Name: z.string(), Labels: LabelsAnswer, UsageData: z.object({ Size: z.number() }).nullish() })
const DiskUsageAnswer = z.object({ Volumes: z.array(VolumeAnswer).nullish() })
const ContainerAnswer = z.object({
  Id: z.string(),
  Name: z.string(),
  State: z.object({ Status: z.string(), Running: z.boolean(), ExitCode: z.number().int() }),
  Config: z.object({ Image: z.string(), Labels: LabelsAnswer }),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.unknown()).nullish() }),
})
const SummariesAnswer = z.array(z.object({ Id: z.string(), Names: z.array(z.string()), State: z.string(), Labels: LabelsAnswer }))

export function createDockerClient(options: DockerClientOptions): DockerClient {
  const config = validatedOptions(options)
  const wire = createWire(config)
  const call: Call = async (request, accepted) => {
    const response = await wire.send(request)
    expectStatus(response, request, accepted)
    return response
  }
  return {
    createNetwork: (name, labels, options) => createNetwork(call, name, labels, options),
    connectNetwork: (network, container) => attach(call, 'connect', network, container),
    disconnectNetwork: (network, container) => attach(call, 'disconnect', network, container),
    removeNetwork: async (name) => {
      await call({ operation: 'network remove', method: 'DELETE', path: `/networks/${segment(name)}` }, [204])
    },
    inspectNetwork: async (name) => {
      const request: WireRequest = { operation: 'network inspect', method: 'GET', path: `/networks/${segment(name)}` }
      const answer = parseAnswer(await call(request, [200]), request.operation, NetworkAnswer)
      return { name: answer.Name, labels: answer.Labels }
    },
    createVolume: (name, labels) => createVolume(call, name, labels),
    removeVolume: async (name) => {
      await call({ operation: 'volume remove', method: 'DELETE', path: `/volumes/${segment(name)}` }, [204])
    },
    inspectVolume: async (name) => {
      const request: WireRequest = { operation: 'volume inspect', method: 'GET', path: `/volumes/${segment(name)}` }
      return volumeInfoOf(parseAnswer(await call(request, [200]), request.operation, VolumeAnswer))
    },
    volumeSize: (name) => volumeSize(call, name),
    createContainer: (name, spec) => createContainer(call, name, spec),
    startContainer: async (id) => {
      await call({ operation: 'container start', method: 'POST', path: `/containers/${segment(id)}/start` }, [204, 304])
    },
    stopContainer: async (id, timeoutS) => {
      const path = `/containers/${segment(id)}/stop`
      const t = checkedStopTimeout(timeoutS)
      // Docker answers only after the grace period (and the kill); the deadline must outlast it.
      const timeoutMs = Math.max(config.timeoutMs, (t + STOP_ANSWER_MARGIN_S) * MS_PER_S)
      await call({ operation: 'container stop', method: 'POST', path, query: { t: String(t) }, timeoutMs }, [204, 304])
    },
    removeContainer: async (id, { force }) => {
      const path = `/containers/${segment(id)}`
      await call({ operation: 'container remove', method: 'DELETE', path, query: { force: String(force) } }, [204])
    },
    inspectContainer: (id) => inspectContainer(call, id),
    listContainers: (filter) => listContainers(call, filter),
    exec: async (container, argv, execOptions) => runExec(wire, segment(container), checkedArgv(argv), checkedExecOptions(execOptions)),
    close: () => wire.close(),
  }
}

// ---------------------------------------------------------------------------
// Operations

/** One request whose status must be one of `accepted`. */
type Call = (request: WireRequest, accepted: readonly number[]) => Promise<WireResponse>

/** Attaches or detaches `container`; Docker answers 403 for a repeat, which stays an error. */
async function attach(call: Call, action: 'connect' | 'disconnect', network: string, container: string): Promise<void> {
  const path = `/networks/${segment(network)}/${action}`
  await call({ operation: `network ${action}`, method: 'POST', path, body: { Container: checkedName(container) } }, [200])
}

async function createNetwork(
  call: Call,
  name: string,
  labels: Labels,
  options?: NetworkOptions,
): Promise<{ readonly id: string }> {
  const request: WireRequest = {
    operation: 'network create',
    method: 'POST',
    path: '/networks/create',
    body: {
      Name: checkedName(name),
      Driver: 'bridge',
      Internal: false,
      Attachable: false,
      Labels: checkedLabels(labels),
      ...(options === undefined ? {} : { Options: checkedOptions(options) }),
    },
  }
  return { id: parseAnswer(await call(request, [201]), request.operation, IdAnswer).Id }
}

async function createVolume(call: Call, name: string, labels: Labels): Promise<VolumeInfo> {
  const request: WireRequest = {
    operation: 'volume create',
    method: 'POST',
    path: '/volumes/create',
    body: { Name: checkedName(name), Driver: 'local', Labels: checkedLabels(labels) },
  }
  return volumeInfoOf(parseAnswer(await call(request, [201]), request.operation, VolumeAnswer))
}

async function volumeSize(call: Call, name: string): Promise<number | undefined> {
  const wanted = checkedName(name)
  const request: WireRequest = { operation: 'disk usage', method: 'GET', path: '/system/df', query: { type: 'volume' } }
  const answer = parseAnswer(await call(request, [200]), request.operation, DiskUsageAnswer)
  const volume = (answer.Volumes ?? []).find((candidate) => candidate.Name === wanted)
  return volume === undefined ? undefined : volumeInfoOf(volume).sizeBytes
}

async function createContainer(call: Call, name: string, spec: ContainerSpec): Promise<CreatedContainer> {
  const request: WireRequest = {
    operation: 'container create',
    method: 'POST',
    path: '/containers/create',
    query: { name: checkedName(name) },
    body: spec,
    redact: (spec.Env ?? []).map((entry) => entry.slice(entry.indexOf('=') + 1)),
  }
  const answer = parseAnswer(await call(request, [201]), request.operation, ContainerCreatedAnswer)
  return { id: answer.Id, warnings: answer.Warnings ?? [] }
}

async function inspectContainer(call: Call, id: string): Promise<ContainerInfo> {
  const request: WireRequest = { operation: 'container inspect', method: 'GET', path: `/containers/${segment(id)}/json` }
  const answer = parseAnswer(await call(request, [200]), request.operation, ContainerAnswer)
  return {
    id: answer.Id,
    name: answer.Name.replace(/^\//, ''),
    status: answer.State.Status,
    running: answer.State.Running,
    exitCode: answer.State.ExitCode,
    image: answer.Config.Image,
    labels: answer.Config.Labels,
    networks: Object.keys(answer.NetworkSettings.Networks ?? {}),
  }
}

async function listContainers(call: Call, filter: ListContainersFilter): Promise<readonly ContainerSummary[]> {
  const labels = typeof filter.label === 'string' ? [filter.label] : [...filter.label]
  if (labels.length === 0 || labels.some((label) => label === '' || CONTROL_CHARS.test(label))) {
    throw new TypeError('listContainers: label filters must be non-empty and free of control characters')
  }
  const request: WireRequest = {
    operation: 'container list',
    method: 'GET',
    path: '/containers/json',
    query: { all: 'true', filters: JSON.stringify({ label: labels }) },
  }
  const answer = parseAnswer(await call(request, [200]), request.operation, SummariesAnswer)
  return answer.map((item) => ({ id: item.Id, name: (item.Names[0] ?? '').replace(/^\//, ''), state: item.State, labels: item.Labels }))
}

function volumeInfoOf(answer: z.output<typeof VolumeAnswer>): VolumeInfo {
  const size = answer.UsageData?.Size
  // Docker reports -1 when it has not computed the size.
  return { name: answer.Name, labels: answer.Labels, sizeBytes: size === undefined || size < 0 ? undefined : size }
}

// ---------------------------------------------------------------------------
// Validation

function validatedOptions(options: DockerClientOptions): { socketPath: string; apiVersion: string; timeoutMs: number } {
  if (options.socketPath === '' || !isAbsolute(options.socketPath) || options.socketPath.includes(NUL)) {
    throw new TypeError('createDockerClient: socketPath must be an absolute path')
  }
  const apiVersion = options.apiVersion ?? DOCKER_API_VERSION
  if (!API_VERSION_PATTERN.test(apiVersion)) throw new TypeError('createDockerClient: apiVersion must look like v1.45')
  const timeoutMs = options.timeoutMs ?? DOCKER_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`createDockerClient: timeoutMs must be a positive finite number, got ${timeoutMs}`)
  }
  return { socketPath: options.socketPath, apiVersion, timeoutMs }
}

function checkedName(name: string): string {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new TypeError('Docker client: a container, network or volume name must match [A-Za-z0-9][A-Za-z0-9_.-]{0,254}')
  }
  return name
}

/** A checked name, encoded for a path (the rule leaves nothing to encode; this is belt and braces). */
function segment(name: string): string {
  return encodeURIComponent(checkedName(name))
}

function checkedLabels(labels: Labels): Labels {
  const bad = Object.entries(labels).some(
    ([key, value]) => key === '' || CONTROL_CHARS.test(key) || typeof value !== 'string' || CONTROL_CHARS.test(value),
  )
  if (bad) throw new TypeError('Docker client: labels must be non-empty keys and string values free of control characters')
  return labels
}

/** Same shape of check as `checkedLabels`, plus a length bound: a network driver option is never a caller-supplied blob. */
function checkedOptions(options: NetworkOptions): NetworkOptions {
  const bad = Object.entries(options).some(
    ([key, value]) =>
      key === '' ||
      key.length > MAX_OPTION_KEY_LENGTH ||
      CONTROL_CHARS.test(key) ||
      typeof value !== 'string' ||
      value.length > MAX_OPTION_VALUE_LENGTH ||
      CONTROL_CHARS.test(value),
  )
  if (bad) {
    throw new TypeError(
      `Docker client: network options must be non-empty keys and string values, free of control characters, ` +
        `keys up to ${MAX_OPTION_KEY_LENGTH} chars and values up to ${MAX_OPTION_VALUE_LENGTH} chars`,
    )
  }
  return options
}

function checkedStopTimeout(timeoutS: number): number {
  if (!Number.isInteger(timeoutS) || timeoutS < 0 || timeoutS > MAX_STOP_TIMEOUT_S) {
    throw new RangeError(`stopContainer: timeoutS must be an integer in 0..${MAX_STOP_TIMEOUT_S}`)
  }
  return timeoutS
}

function checkedArgv(argv: readonly string[]): readonly string[] {
  if (argv.length === 0 || argv.some((arg) => typeof arg !== 'string' || arg.includes(NUL))) {
    throw new TypeError('exec: argv must be a non-empty list of strings without NUL')
  }
  return [...argv]
}

function checkedExecOptions(options: ExecOptions): ExecOptions {
  if (options.user !== undefined && !USER_PATTERN.test(options.user)) {
    throw new TypeError('exec: user must be a name or uid, optionally :group')
  }
  const env = options.env ?? {}
  const bad = Object.entries(env).some(
    ([name, value]) => !ENV_NAME_PATTERN.test(name) || typeof value !== 'string' || value.includes(NUL),
  )
  if (bad) throw new TypeError('exec: env names must be variable names and values free of NUL')
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new RangeError('exec: timeoutMs must be a positive finite number')
  }
  return options
}
