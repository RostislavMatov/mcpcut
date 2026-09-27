import { describeOrchestratorError } from '../orchestrator.js'
import { createTenantSlots, type TenantSlots } from './capacity.js'
import { DockerApiError, type ContainerInfo, type DockerClient } from './docker.js'
import { asProvisionerError, ProvisionerError } from './errors.js'
import { createKeyedLock } from './keyed-lock.js'
import {
  adminNameOf,
  containerSpec,
  isTenantLogin,
  isTenantSubdomain,
  LOGIN_LABEL,
  tenantLabels,
  tenantNames,
  TENANT_LABEL,
  type TenantNames,
} from './templates.js'
import { mintOwnerToken, waitUntilReady, type ReadinessOptions } from './tenant-exec.js'

/**
 * What the provisioner does (plan `tenant-orchestrator`, Task 4): create,
 * rotate, remove and describe one tenant's install, each built from the
 * fixed templates in `templates.ts`.
 *
 * - `create`: network → volume → container → start → attach Caddy → wait
 *   until `status --json` says both services answer (≤ 45 s) → `admin add
 *   --json`. A failure at ANY step removes what this call created, in
 *   reverse, and rethrows the first failure; nothing that existed before the
 *   call is touched (a tenant whose container or volume already exists is
 *   refused as `exists` before anything is created).
 * - `rotateOwnerToken`: `admin rotate <login> --recover --json`, the login
 *   read back from the container's own label.
 * - `remove`: detach Caddy → stop → remove the container → the volume → the
 *   network. Idempotent: whatever is already gone counts as removed. The
 *   container, the volume and the network are each removed only when they
 *   carry this tenant's label; otherwise the call fails `not-ours`.
 * - `status`: the container's state and the volume's size (O9).
 *
 * Every input is validated before the first Docker call, and an object that
 * carries another tenant's label is never touched. Mutations of one
 * subdomain run one at a time; the tenant ceiling is checked and a slot
 * reserved in one step for the whole host (`capacity.ts`). Tokens are
 * returned, never logged.
 */

export const DEFAULT_MAX_TENANTS = 20
const STOP_TIMEOUT_S = 10
/** GitHub ids are positive integers; anything else is not one. */
const MAX_GITHUB_ID = Number.MAX_SAFE_INTEGER

export interface CreateTenantInput {
  readonly subdomain: string
  readonly login: string
  readonly githubId?: number
}

export interface TenantStatus {
  /** `absent`, or Docker's container status (`running`, `restarting`, `exited`, …). */
  readonly state: string
  /** The volume's size when Docker knows it (O9); `null` otherwise. */
  readonly sizeBytes: number | null
}

export interface ProvisionerServiceOptions {
  readonly docker: DockerClient
  readonly image: string
  readonly publicDomain: string
  /** The Caddy container attached to every tenant network (O4/O5); none in a test or a Caddy-less smoke. */
  readonly caddyContainer?: string
  readonly maxTenants?: number
  readonly readiness?: ReadinessOptions
  /** One line per event; never a token. */
  readonly log?: (line: string) => void
}

export interface ProvisionerService {
  create(input: CreateTenantInput): Promise<{ readonly ownerToken: string }>
  rotateOwnerToken(subdomain: string): Promise<{ readonly ownerToken: string }>
  remove(subdomain: string): Promise<void>
  status(subdomain: string): Promise<TenantStatus>
}

interface Context {
  readonly options: ProvisionerServiceOptions
  readonly docker: DockerClient
  readonly slots: TenantSlots
  readonly log: (line: string) => void
}

export function createProvisionerService(options: ProvisionerServiceOptions): ProvisionerService {
  const slots = createTenantSlots(options.maxTenants ?? DEFAULT_MAX_TENANTS)
  const ctx: Context = { options, docker: options.docker, slots, log: options.log ?? (() => undefined) }
  const lock = createKeyedLock()
  // `async` throughout: a refused input is a rejected promise, like every other failure.
  return Object.freeze({
    create: async (input: CreateTenantInput) => {
      const checked = checkedCreateInput(input)
      return lock.run(checked.subdomain, () => createTenant(ctx, checked))
    },
    rotateOwnerToken: async (subdomain: string) => {
      const names = namesOf(subdomain)
      return lock.run(subdomain, () => rotateTenant(ctx, subdomain, names))
    },
    remove: async (subdomain: string) => {
      const names = namesOf(subdomain)
      return lock.run(subdomain, () => removeTenant(ctx, subdomain, names))
    },
    status: async (subdomain: string) => statusOf(ctx, subdomain, namesOf(subdomain)),
  })
}

// ---------------------------------------------------------------------------
// Validation

function namesOf(subdomain: string): TenantNames {
  if (!isTenantSubdomain(subdomain)) throw new ProvisionerError('invalid-input', 'subdomain: not a valid tenant subdomain')
  return tenantNames(subdomain)
}

function checkedCreateInput(input: CreateTenantInput): CreateTenantInput {
  namesOf(input.subdomain)
  if (!isTenantLogin(input.login)) throw new ProvisionerError('invalid-input', 'login: not a GitHub login')
  const id = input.githubId
  if (id !== undefined && (!Number.isInteger(id) || id <= 0 || id > MAX_GITHUB_ID)) {
    throw new ProvisionerError('invalid-input', 'githubId: not a positive integer')
  }
  return input
}

// ---------------------------------------------------------------------------
// create

/** Undoes one step of a create; run in reverse order on failure. */
interface UndoStep {
  readonly what: string
  readonly undo: () => Promise<void>
}

async function createTenant(ctx: Context, input: CreateTenantInput): Promise<{ readonly ownerToken: string }> {
  await assertAbsent(ctx.docker, tenantNames(input.subdomain))
  const release = await ctx.slots.reserve(input.subdomain, () => tenantSubdomains(ctx.docker))
  try {
    return await buildTenant(ctx, input)
  } finally {
    release()
  }
}

async function buildTenant(ctx: Context, input: CreateTenantInput): Promise<{ readonly ownerToken: string }> {
  const { docker, options } = ctx
  const names = tenantNames(input.subdomain)
  const labels = tenantLabels(input.subdomain)
  const spec = containerSpec({ ...input, image: options.image, publicDomain: options.publicDomain })
  let undo: readonly UndoStep[] = []
  const step = async (what: string, run: () => Promise<void>, reverse?: () => Promise<void>): Promise<void> => {
    await run()
    if (reverse !== undefined) undo = [{ what, undo: reverse }, ...undo]
  }
  try {
    await step('network', async () => void (await docker.createNetwork(names.network, labels)), () => docker.removeNetwork(names.network))
    await step('volume', async () => void (await docker.createVolume(names.volume, labels)), () => docker.removeVolume(names.volume))
    await step('container', async () => void (await docker.createContainer(names.container, spec)), () =>
      docker.removeContainer(names.container, { force: true }),
    )
    await step('start', () => docker.startContainer(names.container))
    const caddy = options.caddyContainer
    if (caddy !== undefined) {
      await step('caddy', () => docker.connectNetwork(names.network, caddy), () => docker.disconnectNetwork(names.network, caddy))
    }
    await waitUntilReady(docker, names.container, options.readiness)
    const ownerToken = await mintOwnerToken(docker, names.container, adminNameOf(input.login), 'add')
    ctx.log(`[provisioner] created ${input.subdomain}`)
    return { ownerToken }
  } catch (error: unknown) {
    const failure = asProvisionerError(error, `create ${input.subdomain}`)
    await rollback(ctx, input.subdomain, undo)
    ctx.log(`[provisioner] create ${input.subdomain} failed, rolled back: ${describeOrchestratorError(failure)}`)
    throw failure
  }
}

/** A container or volume by the tenant's name is someone's data: never reused, never overwritten. */
async function assertAbsent(docker: DockerClient, names: TenantNames): Promise<void> {
  const found = await Promise.all([
    exists(() => docker.inspectContainer(names.container)),
    exists(() => docker.inspectVolume(names.volume)),
  ])
  if (found.some(Boolean)) {
    throw new ProvisionerError('exists', `create: ${names.container} already exists (remove it first)`)
  }
}

/** The subdomain of every tenant install Docker holds, in any state; an unlabelled value counts by container name. */
async function tenantSubdomains(docker: DockerClient): Promise<readonly string[]> {
  const tenants = await docker.listContainers({ label: TENANT_LABEL })
  return tenants.map((tenant) => tenant.labels[TENANT_LABEL] ?? `container:${tenant.name}`)
}

async function rollback(ctx: Context, subdomain: string, steps: readonly UndoStep[]): Promise<void> {
  for (const step of steps) {
    try {
      await step.undo()
    } catch (error: unknown) {
      if (error instanceof DockerApiError && error.notFound) continue
      ctx.log(`[provisioner] rollback of ${subdomain} could not undo the ${step.what}: ${describeOrchestratorError(error)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// rotate, remove, status

async function rotateTenant(ctx: Context, subdomain: string, names: TenantNames): Promise<{ readonly ownerToken: string }> {
  try {
    const info = await inspectOurs(ctx.docker, names, subdomain)
    if (info === undefined) throw new ProvisionerError('not-found', `rotate: no install for ${subdomain}`)
    const login = info.labels[LOGIN_LABEL]
    if (login === undefined || !isTenantLogin(login)) throw new ProvisionerError('not-ours', `rotate: ${names.container} has no login label`)
    if (!info.running) throw new ProvisionerError('not-ready', `rotate: the install for ${subdomain} is not running`)
    const ownerToken = await mintOwnerToken(ctx.docker, names.container, adminNameOf(login), 'rotate')
    ctx.log(`[provisioner] owner token rotated for ${subdomain}`)
    return { ownerToken }
  } catch (error: unknown) {
    throw asProvisionerError(error, `rotate ${subdomain}`)
  }
}

async function removeTenant(ctx: Context, subdomain: string, names: TenantNames): Promise<void> {
  const { docker } = ctx
  try {
    const info = await inspectOurs(docker, names, subdomain)
    // Checked before Caddy is detached: another tenant's network is not touched at all.
    const hasNetwork = await isNetworkOurs(docker, names, subdomain)
    if (hasNetwork) await detachCaddy(ctx, names)
    if (info !== undefined) {
      await ignoreNotFound(() => docker.stopContainer(names.container, STOP_TIMEOUT_S))
      await ignoreNotFound(() => docker.removeContainer(names.container, { force: true }))
    }
    await removeVolumeIfOurs(docker, names, subdomain)
    if (hasNetwork) await ignoreNotFound(() => docker.removeNetwork(names.network))
    ctx.log(`[provisioner] removed ${subdomain}`)
  } catch (error: unknown) {
    throw asProvisionerError(error, `remove ${subdomain}`)
  }
}

async function detachCaddy(ctx: Context, names: TenantNames): Promise<void> {
  const caddy = ctx.options.caddyContainer
  if (caddy === undefined) return
  const info = await inspectOrAbsent(() => ctx.docker.inspectContainer(caddy))
  if (info === undefined || !info.networks.includes(names.network)) return
  await ignoreNotFound(() => ctx.docker.disconnectNetwork(names.network, caddy))
}

/** True when the tenant's network exists and is labelled as its; another tenant's label is refused. */
async function isNetworkOurs(docker: DockerClient, names: TenantNames, subdomain: string): Promise<boolean> {
  const network = await inspectOrAbsent(() => docker.inspectNetwork(names.network))
  if (network === undefined) return false
  if (network.labels[TENANT_LABEL] !== subdomain) throw notOurs(names.network)
  return true
}

async function removeVolumeIfOurs(docker: DockerClient, names: TenantNames, subdomain: string): Promise<void> {
  const volume = await inspectOrAbsent(() => docker.inspectVolume(names.volume))
  if (volume === undefined) return
  if (volume.labels[TENANT_LABEL] !== subdomain) throw notOurs(names.volume)
  await ignoreNotFound(() => docker.removeVolume(names.volume))
}

async function statusOf(ctx: Context, subdomain: string, names: TenantNames): Promise<TenantStatus> {
  try {
    const info = await inspectOurs(ctx.docker, names, subdomain)
    if (info === undefined) return { state: 'absent', sizeBytes: null }
    const size = await ctx.docker.volumeSize(names.volume)
    return { state: info.status, sizeBytes: size ?? null }
  } catch (error: unknown) {
    throw asProvisionerError(error, `status ${subdomain}`)
  }
}

// ---------------------------------------------------------------------------
// Helpers

/** The tenant's container, `undefined` when there is none; another tenant's label is refused. */
async function inspectOurs(docker: DockerClient, names: TenantNames, subdomain: string): Promise<ContainerInfo | undefined> {
  const info = await inspectOrAbsent(() => docker.inspectContainer(names.container))
  if (info !== undefined && info.labels[TENANT_LABEL] !== subdomain) throw notOurs(names.container)
  return info
}

function notOurs(name: string): ProvisionerError {
  return new ProvisionerError('not-ours', `${name} is not labelled as this tenant's; it was left alone`)
}

async function inspectOrAbsent<T>(inspect: () => Promise<T>): Promise<T | undefined> {
  try {
    return await inspect()
  } catch (error: unknown) {
    if (error instanceof DockerApiError && error.notFound) return undefined
    throw error
  }
}

async function exists(inspect: () => Promise<unknown>): Promise<boolean> {
  return (await inspectOrAbsent(inspect)) !== undefined
}

async function ignoreNotFound(action: () => Promise<void>): Promise<void> {
  await inspectOrAbsent(action)
}
