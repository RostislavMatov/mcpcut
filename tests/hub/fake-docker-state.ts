/**
 * The in-memory half of the fake Docker Engine (`fake-docker.ts`): networks,
 * volumes, containers and exec instances, and the JSON endpoints over them
 * with the status codes the real daemon uses. The exec *stream* lives in
 * `fake-docker.ts`, because it writes on the raw socket.
 *
 * Status codes mirror moby: 201 on create, 204 on start/stop/delete, 304 when
 * a container is already in the asked state, 404 for an unknown object, 409
 * for a name conflict or an object in use, 403 for a network operation the
 * daemon forbids (already connected, not connected, active endpoints).
 */

export interface FakeNetwork {
  readonly id: string
  readonly name: string
  readonly labels: Readonly<Record<string, string>>
  /** Container ids attached. */
  readonly containers: ReadonlySet<string>
}

export interface FakeVolume {
  readonly name: string
  readonly labels: Readonly<Record<string, string>>
  readonly sizeBytes: number | undefined
}

export interface FakeContainer {
  readonly id: string
  readonly name: string
  readonly spec: Readonly<Record<string, unknown>>
  readonly labels: Readonly<Record<string, string>>
  readonly running: boolean
  readonly everStarted: boolean
}

export interface FakeExecInstance {
  readonly id: string
  readonly containerId: string
  readonly argv: readonly string[]
  readonly user: string | undefined
  readonly env: readonly string[]
  readonly started: boolean
  readonly exitCode: number | undefined
  /** Inspections still to answer `Running: true` after the stream ended. */
  readonly runningInspections: number
}

export interface Reply {
  readonly status: number
  readonly body?: unknown
}

export interface FakeStore {
  readonly networks: Map<string, FakeNetwork>
  readonly volumes: Map<string, FakeVolume>
  readonly containers: Map<string, FakeContainer>
  readonly execs: Map<string, FakeExecInstance>
  nextId(): string
}

export function createStore(): FakeStore {
  let counter = 0
  return {
    networks: new Map(),
    volumes: new Map(),
    containers: new Map(),
    execs: new Map(),
    nextId: () => {
      counter += 1
      return counter.toString(16).padStart(64, 'f')
    },
  }
}

const noSuch = (what: string, ref: string): Reply => ({ status: 404, body: { message: `No such ${what}: ${ref}` } })
const conflict = (message: string): Reply => ({ status: 409, body: { message } })
const forbidden = (message: string): Reply => ({ status: 403, body: { message } })
const badRequest = (message: string): Reply => ({ status: 400, body: { message } })

function objectBody(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

function labelsOf(value: unknown): Record<string, string> {
  const entries = Object.entries(objectBody(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return Object.fromEntries(entries)
}

export function findContainer(store: FakeStore, ref: string): FakeContainer | undefined {
  return store.containers.get(ref) ?? [...store.containers.values()].find((container) => container.name === ref)
}

function findNetwork(store: FakeStore, ref: string): FakeNetwork | undefined {
  return [...store.networks.values()].find((network) => network.id === ref || network.name === ref)
}

// ---------------------------------------------------------------------------
// Networks

export function createNetwork(store: FakeStore, body: unknown): Reply {
  const input = objectBody(body)
  const name = input['Name']
  if (typeof name !== 'string' || name === '') return badRequest('network name is required')
  if (findNetwork(store, name) !== undefined) return conflict(`network with name ${name} already exists`)
  const id = store.nextId()
  store.networks.set(id, { id, name, labels: labelsOf(input['Labels']), containers: new Set() })
  return { status: 201, body: { Id: id, Warning: '' } }
}

export function connectNetwork(store: FakeStore, ref: string, body: unknown): Reply {
  const network = findNetwork(store, ref)
  if (network === undefined) return noSuch('network', ref)
  const containerRef = String(objectBody(body)['Container'] ?? '')
  const container = findContainer(store, containerRef)
  if (container === undefined) return noSuch('container', containerRef)
  if (network.containers.has(container.id)) {
    return forbidden(`endpoint with name ${container.name} already exists in network ${network.name}`)
  }
  store.networks.set(network.id, { ...network, containers: new Set([...network.containers, container.id]) })
  return { status: 200 }
}

export function disconnectNetwork(store: FakeStore, ref: string, body: unknown): Reply {
  const network = findNetwork(store, ref)
  if (network === undefined) return noSuch('network', ref)
  const containerRef = String(objectBody(body)['Container'] ?? '')
  const container = findContainer(store, containerRef)
  if (container === undefined) return noSuch('container', containerRef)
  if (!network.containers.has(container.id)) {
    return forbidden(`container ${container.id} is not connected to network ${network.name}`)
  }
  const remaining = [...network.containers].filter((id) => id !== container.id)
  store.networks.set(network.id, { ...network, containers: new Set(remaining) })
  return { status: 200 }
}

export function inspectNetwork(store: FakeStore, ref: string): Reply {
  const network = findNetwork(store, ref)
  if (network === undefined) return noSuch('network', ref)
  const containers = Object.fromEntries([...network.containers].map((id) => [id, { Name: findContainer(store, id)?.name ?? id }]))
  return { status: 200, body: { Name: network.name, Id: network.id, Driver: 'bridge', Labels: network.labels, Containers: containers } }
}

export function removeNetwork(store: FakeStore, ref: string): Reply {
  const network = findNetwork(store, ref)
  if (network === undefined) return noSuch('network', ref)
  if (network.containers.size > 0) return forbidden(`error while removing network: network ${network.name} has active endpoints`)
  store.networks.delete(network.id)
  return { status: 204 }
}

// ---------------------------------------------------------------------------
// Volumes

function volumeJson(volume: FakeVolume, withUsage: boolean): Record<string, unknown> {
  return {
    Name: volume.name,
    Driver: 'local',
    Mountpoint: `/var/lib/docker/volumes/${volume.name}/_data`,
    Labels: volume.labels,
    Scope: 'local',
    // The real daemon fills `UsageData` only in `/system/df`.
    UsageData: withUsage ? { Size: volume.sizeBytes ?? -1, RefCount: 0 } : null,
  }
}

export function createVolume(store: FakeStore, body: unknown): Reply {
  const input = objectBody(body)
  const name = input['Name']
  if (typeof name !== 'string' || name === '') return badRequest('volume name is required')
  // Docker answers 201 with the existing volume when the name is taken.
  const existing = store.volumes.get(name)
  const volume = existing ?? { name, labels: labelsOf(input['Labels']), sizeBytes: undefined }
  store.volumes.set(name, volume)
  return { status: 201, body: volumeJson(volume, false) }
}

export function inspectVolume(store: FakeStore, name: string): Reply {
  const volume = store.volumes.get(name)
  return volume === undefined ? noSuch('volume', name) : { status: 200, body: volumeJson(volume, false) }
}

function mountsVolume(container: FakeContainer, name: string): boolean {
  const hostConfig = objectBody(container.spec['HostConfig'])
  const mounts = Array.isArray(hostConfig['Mounts']) ? hostConfig['Mounts'] : []
  return mounts.some((mount) => objectBody(mount)['Type'] === 'volume' && objectBody(mount)['Source'] === name)
}

export function removeVolume(store: FakeStore, name: string): Reply {
  if (!store.volumes.has(name)) return noSuch('volume', name)
  const user = [...store.containers.values()].find((container) => mountsVolume(container, name))
  if (user !== undefined) return conflict(`remove ${name}: volume is in use - [${user.id}]`)
  store.volumes.delete(name)
  return { status: 204 }
}

export function systemDf(store: FakeStore): Reply {
  return { status: 200, body: { Volumes: [...store.volumes.values()].map((volume) => volumeJson(volume, true)) } }
}

// ---------------------------------------------------------------------------
// Containers

export function createContainer(store: FakeStore, name: string | null, body: unknown): Reply {
  const spec = objectBody(body)
  if (typeof spec['Image'] !== 'string' || spec['Image'] === '') return badRequest('config cannot be empty in order to create a container')
  if (name === null || name === '') return badRequest('the fake requires ?name=')
  const clash = findContainer(store, name)
  if (clash !== undefined) return conflict(`Conflict. The container name "/${name}" is already in use by container "${clash.id}".`)
  const id = store.nextId()
  store.containers.set(id, { id, name, spec, labels: labelsOf(spec['Labels']), running: false, everStarted: false })
  return { status: 201, body: { Id: id, Warnings: [] } }
}

export function setRunning(store: FakeStore, ref: string, running: boolean): Reply {
  const container = findContainer(store, ref)
  if (container === undefined) return noSuch('container', ref)
  if (container.running === running) return { status: 304 }
  store.containers.set(container.id, { ...container, running, everStarted: container.everStarted || running })
  return { status: 204 }
}

export function removeContainer(store: FakeStore, ref: string, force: boolean): Reply {
  const container = findContainer(store, ref)
  if (container === undefined) return noSuch('container', ref)
  if (container.running && !force) {
    return conflict(`cannot remove container "/${container.name}": container is running: stop the container before removing or force remove`)
  }
  for (const network of store.networks.values()) {
    const remaining = [...network.containers].filter((id) => id !== container.id)
    store.networks.set(network.id, { ...network, containers: new Set(remaining) })
  }
  store.containers.delete(container.id)
  return { status: 204 }
}

function statusWord(container: FakeContainer): string {
  if (container.running) return 'running'
  return container.everStarted ? 'exited' : 'created'
}

export function inspectContainer(store: FakeStore, ref: string): Reply {
  const container = findContainer(store, ref)
  if (container === undefined) return noSuch('container', ref)
  const networks = [...store.networks.values()].filter((network) => network.containers.has(container.id))
  return {
    status: 200,
    body: {
      Id: container.id,
      Name: `/${container.name}`,
      State: { Status: statusWord(container), Running: container.running, ExitCode: 0 },
      Config: { Image: container.spec['Image'], Labels: container.labels },
      HostConfig: container.spec['HostConfig'] ?? {},
      NetworkSettings: { Networks: Object.fromEntries(networks.map((network) => [network.name, { NetworkID: network.id }])) },
    },
  }
}

/** `filters={"label":["k=v","k"]}` — every listed label must match. */
function matchesLabels(container: FakeContainer, wanted: readonly string[]): boolean {
  return wanted.every((filter) => {
    const at = filter.indexOf('=')
    if (at < 0) return Object.hasOwn(container.labels, filter)
    return container.labels[filter.slice(0, at)] === filter.slice(at + 1)
  })
}

export function listContainers(store: FakeStore, query: URLSearchParams): Reply {
  let wanted: readonly string[] = []
  const raw = query.get('filters')
  if (raw !== null) {
    const parsed = objectBody(JSON.parse(raw) as unknown)
    const labels = parsed['label']
    if (labels !== undefined && (!Array.isArray(labels) || !labels.every((item) => typeof item === 'string'))) {
      return badRequest('invalid filter: label must be an array of strings')
    }
    wanted = (labels as string[] | undefined) ?? []
  }
  const all = query.get('all') === 'true' || query.get('all') === '1'
  const shown = [...store.containers.values()].filter((container) => (all || container.running) && matchesLabels(container, wanted))
  const body = shown.map((container) => ({
    Id: container.id,
    Names: [`/${container.name}`],
    Image: container.spec['Image'],
    State: statusWord(container),
    Status: container.running ? 'Up 1 second' : 'Created',
    Labels: container.labels,
  }))
  return { status: 200, body }
}

// ---------------------------------------------------------------------------
// Exec (create and inspect; the stream is in fake-docker.ts)

export function createExec(store: FakeStore, ref: string, body: unknown): Reply {
  const container = findContainer(store, ref)
  if (container === undefined) return noSuch('container', ref)
  if (!container.running) return conflict(`container ${container.id} is not running`)
  const input = objectBody(body)
  const argv = input['Cmd']
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((item) => typeof item === 'string')) {
    return badRequest('No exec command specified')
  }
  const env = Array.isArray(input['Env']) ? input['Env'].filter((item): item is string => typeof item === 'string') : []
  const user = typeof input['User'] === 'string' ? input['User'] : undefined
  const id = store.nextId()
  store.execs.set(id, { id, containerId: container.id, argv, user, env, started: false, exitCode: undefined, runningInspections: 0 })
  return { status: 201, body: { Id: id } }
}

export function inspectExec(store: FakeStore, id: string): Reply {
  const exec = store.execs.get(id)
  if (exec === undefined) return noSuch('exec instance', id)
  const running = exec.runningInspections > 0 || (exec.started && exec.exitCode === undefined)
  if (exec.runningInspections > 0) store.execs.set(id, { ...exec, runningInspections: exec.runningInspections - 1 })
  return {
    status: 200,
    body: { ID: exec.id, ContainerID: exec.containerId, Running: running, ExitCode: running ? null : (exec.exitCode ?? null) },
  }
}
