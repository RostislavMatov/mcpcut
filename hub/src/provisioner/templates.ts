import { createHash } from 'node:crypto'
import { isAssignableSubdomain } from '../subdomain.js'
import type { ContainerSpec, Labels, NetworkOptions } from './docker-types.js'

/**
 * The fixed shapes of a tenant's Docker objects (plan `tenant-orchestrator`,
 * Task 4, decisions O2–O4). The provisioner holds the Docker socket, so what
 * it may create is decided HERE, not by whoever calls it: a caller supplies a
 * subdomain and a login, both validated below, and gets back exactly one
 * container shape — capped, capability-less, read-only, on its own network,
 * publishing no port. Nothing in the HTTP API can add a bind mount, a
 * capability, a port or a different network.
 */

/** Every tenant object's name starts with this; Caddy's upstream is `mcpcut-t-<sub>` (O5). */
export const TENANT_NAME_PREFIX = 'mcpcut-t-'
export const TENANT_LABEL = 'mcpcut.tenant'
export const LOGIN_LABEL = 'mcpcut.login'
export const GITHUB_ID_LABEL = 'mcpcut.github-id'

/**
 * Every tenant network's bridge interface starts with this on the host (fix
 * `tenant-network-isolation`): a single `iptables`/`ip6tables` rule matching
 * `mct+` covers every tenant, present or future, with no per-tenant rule and
 * no reload when one is created or removed — the same reasoning as Caddy's
 * one `*.mcpcut.com` block (O5).
 */
export const TENANT_BRIDGE_PREFIX = 'mct'
/** Linux `IFNAMSIZ` caps an interface name at 15 usable characters (16 with the trailing NUL). */
const MAX_BRIDGE_INTERFACE_LENGTH = 15
const BRIDGE_HASH_HEX_LENGTH = MAX_BRIDGE_INTERFACE_LENGTH - TENANT_BRIDGE_PREFIX.length

/** Where the install's home (`config.json` and `data/`) lives: the tenant's volume. */
export const TENANT_HOME_MOUNT = '/home/node/.mcpcut'
/** The user every tenant process runs as, and every exec too. */
export const TENANT_USER = 'node'
/** The image's CLI — `docker/tenant-run.sh` starts `ui` and `serve` from the same file. */
export const TENANT_CLI: readonly string[] = Object.freeze(['node', '/app/dist/cli.js'])

/**
 * A DNS label is at most 63 characters, and the container name — which Caddy
 * resolves on the tenant network — is the prefix plus the subdomain, so the
 * subdomain may use what is left. A GitHub login is at most 39 characters and
 * the hub's collision suffix adds at most four, so no real subdomain is near it.
 */
export const MAX_TENANT_SUBDOMAIN_LENGTH = 63 - TENANT_NAME_PREFIX.length

const MIB = 1024 * 1024
/** O3: per-tenant ceilings on a shared host. */
const MEMORY_BYTES = 256 * MIB
const NANO_CPUS = 250_000_000
const PIDS_LIMIT = 128
const TMPFS_OPTIONS = 'rw,noexec,nosuid,nodev,size=16m'
const LOG_MAX_SIZE = '1m'
const LOG_MAX_FILES = '3'

/** GitHub's rule for logins: alphanumerics and inner hyphens, at most 39. */
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
/** `repo[:tag]` with an optional registry path; no digest, no whitespace. */
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,199}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/

export interface TenantNames {
  readonly container: string
  readonly network: string
  readonly volume: string
}

export interface ContainerSpecInput {
  readonly subdomain: string
  readonly login: string
  readonly image: string
  readonly publicDomain: string
  readonly githubId?: number
}

/** A subdomain the provisioner will name Docker objects after: the hub's rule, and short enough for one DNS label. */
export function isTenantSubdomain(candidate: string): boolean {
  return (
    typeof candidate === 'string' &&
    candidate.length <= MAX_TENANT_SUBDOMAIN_LENGTH &&
    isAssignableSubdomain(candidate)
  )
}

export function isTenantLogin(candidate: string): boolean {
  return typeof candidate === 'string' && LOGIN_PATTERN.test(candidate)
}

export function isImageReference(candidate: string): boolean {
  return typeof candidate === 'string' && IMAGE_PATTERN.test(candidate)
}

export function isPublicDomain(candidate: string): boolean {
  return typeof candidate === 'string' && DOMAIN_PATTERN.test(candidate)
}

/** The install's owner admin name: admin names are lowercase (`ADMIN_NAME_PATTERN`), logins are not. */
export function adminNameOf(login: string): string {
  return login.toLowerCase()
}

export function tenantNames(subdomain: string): TenantNames {
  if (!isTenantSubdomain(subdomain)) throw new TypeError('tenant: the subdomain is not a valid tenant subdomain')
  const name = `${TENANT_NAME_PREFIX}${subdomain}`
  return Object.freeze({ container: name, network: name, volume: name })
}

export function tenantLabels(subdomain: string, login?: string, githubId?: number): Labels {
  return Object.freeze({
    [TENANT_LABEL]: subdomain,
    ...(login === undefined ? {} : { [LOGIN_LABEL]: login }),
    ...(githubId === undefined ? {} : { [GITHUB_ID_LABEL]: String(githubId) }),
  })
}

export function tenantPublicUrl(subdomain: string, publicDomain: string): string {
  return `https://${subdomain}.${publicDomain}`
}

/**
 * The predictable bridge interface name Docker gives a tenant's network on
 * the host, so a host firewall rule can match every tenant's traffic with one
 * `-i mct+` clause. `sha256`, not the subdomain itself, because a subdomain
 * can be up to `MAX_TENANT_SUBDOMAIN_LENGTH` characters — far more than
 * `IFNAMSIZ` leaves room for after the prefix. Truncating a hash to 12 hex
 * characters risks a collision only across many more tenants than the host's
 * own ceiling (`DEFAULT_MAX_TENANTS = 20`) ever allows, so it is accepted
 * without a collision check.
 */
export function bridgeInterfaceName(subdomain: string): string {
  if (!isTenantSubdomain(subdomain)) throw new TypeError('tenant: the subdomain is not a valid tenant subdomain')
  const hash = createHash('sha256').update(subdomain, 'utf8').digest('hex').slice(0, BRIDGE_HASH_HEX_LENGTH)
  return `${TENANT_BRIDGE_PREFIX}${hash}`
}

/** The tenant network's driver options: a fixed bridge interface name, for the host firewall (fix `tenant-network-isolation`). */
export function tenantNetworkOptions(subdomain: string): NetworkOptions {
  return Object.freeze({ 'com.docker.network.bridge.name': bridgeInterfaceName(subdomain) })
}

/** The one container a tenant gets (O2/O3/O4). Frozen all the way down. */
export function containerSpec(input: ContainerSpecInput): ContainerSpec {
  const names = tenantNames(input.subdomain)
  if (!isTenantLogin(input.login)) throw new TypeError('tenant: the login is not a GitHub login')
  if (!isImageReference(input.image)) throw new TypeError('tenant: the image is not an image reference')
  if (!isPublicDomain(input.publicDomain)) throw new TypeError('tenant: the public domain is not a domain name')
  const publicUrl = tenantPublicUrl(input.subdomain, input.publicDomain)
  return deepFreeze({
    Image: input.image,
    Env: [
      'MCPCUT_TENANT=1',
      `MCPCUT_UI_PUBLIC_URL=${publicUrl}`,
      `MCPCUT_SERVE_PUBLIC_URL=${publicUrl}`,
      'MCPCUT_UI_HOST=0.0.0.0',
      'MCPCUT_SERVE_HOST=0.0.0.0',
      // SQLite and the run script's FIFO: the only writable place off the volume.
      'TMPDIR=/tmp',
    ],
    User: TENANT_USER,
    Labels: tenantLabels(input.subdomain, input.login, input.githubId),
    HostConfig: {
      Memory: MEMORY_BYTES,
      // Equal to Memory: no swap on a shared host.
      MemorySwap: MEMORY_BYTES,
      NanoCpus: NANO_CPUS,
      PidsLimit: PIDS_LIMIT,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': TMPFS_OPTIONS },
      Mounts: [{ Type: 'volume', Source: names.volume, Target: TENANT_HOME_MOUNT }],
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: names.network,
      // Docker's init as PID 1 reaps the grandchildren `ui`/`serve` spawn.
      Init: true,
      LogConfig: { Type: 'json-file', Config: { 'max-size': LOG_MAX_SIZE, 'max-file': LOG_MAX_FILES } },
    },
  })
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
