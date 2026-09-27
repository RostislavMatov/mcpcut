import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { readBearerTokenFile, type SecretFileSeams } from '../secret-file.js'
import { DEFAULT_MAX_TENANTS } from './service.js'
import { isImageReference, isPublicDomain } from './templates.js'

/**
 * The provisioner's configuration (plan `tenant-orchestrator`, Task 4): env
 * vars only, the hub's pattern (`hub/src/config.ts`). The Bearer secret the
 * hub presents is read from `PROVISIONER_TOKEN_FILE` (0600 or 0400) and never
 * accepted in the environment. `loadProvisionerConfig` never throws; every
 * problem comes back as one line for the entry point to print.
 */

const MAX_TCP_PORT = 65535
const MAX_ENV_STRING_LENGTH = 4096
const MAX_TENANTS_BOUND = 1000
/** Docker's own rule for container names. */
const CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/

export const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock'
export const DEFAULT_TENANT_IMAGE = 'mcpcut-tenant:local'
export const DEFAULT_PUBLIC_DOMAIN = 'mcpcut.com'
export const DEFAULT_PROVISIONER_HOST = '0.0.0.0'
export const DEFAULT_PROVISIONER_PORT = 8093

const boundedString = z.string({ error: 'is required' }).min(1, 'is required').max(MAX_ENV_STRING_LENGTH, 'is too long')

function intEnvField(min: number, max: number) {
  const message = `must be an integer between ${min} and ${max}`
  return z.coerce.number({ error: message }).int(message).min(min, message).max(max, message)
}

/** Empty means unset, as everywhere in this codebase's env seams. */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === '' ? undefined : value), schema.optional())

const rawSchema = z.object({
  PROVISIONER_TOKEN_FILE: boundedString,
  PROVISIONER_DOCKER_SOCKET: optional(boundedString.refine(isAbsolute, 'must be an absolute path')),
  PROVISIONER_IMAGE: optional(boundedString.refine(isImageReference, 'must be an image reference, e.g. mcpcut-tenant:local')),
  PROVISIONER_CADDY_CONTAINER: optional(boundedString.regex(CONTAINER_NAME_PATTERN, 'must be a container name')),
  PROVISIONER_PUBLIC_DOMAIN: optional(boundedString.refine(isPublicDomain, 'must be a domain name, e.g. mcpcut.com')),
  PROVISIONER_HOST: optional(boundedString),
  PROVISIONER_PORT: optional(intEnvField(0, MAX_TCP_PORT)),
  PROVISIONER_MAX_TENANTS: optional(intEnvField(1, MAX_TENANTS_BOUND)),
})

export interface ProvisionerConfig {
  /** Never logged: the Bearer secret the hub must present. */
  readonly token: string
  readonly dockerSocket: string
  readonly image: string
  /** Attached to every tenant network; `undefined` leaves tenants unrouted (a smoke without Caddy). */
  readonly caddyContainer: string | undefined
  readonly publicDomain: string
  readonly host: string
  readonly port: number
  readonly maxTenants: number
}

export type ProvisionerConfigLoad =
  | { readonly kind: 'ok'; readonly config: ProvisionerConfig }
  | { readonly kind: 'invalid'; readonly problems: readonly string[] }

export interface LoadProvisionerConfigOptions extends SecretFileSeams {
  readonly env?: NodeJS.ProcessEnv
}

const VAR_NAMES = Object.keys(rawSchema.shape) as readonly (keyof z.input<typeof rawSchema>)[]

export function loadProvisionerConfig(options: LoadProvisionerConfigOptions = {}): ProvisionerConfigLoad {
  const env = options.env ?? process.env
  const raw = Object.fromEntries(VAR_NAMES.map((name) => [name, env[name]]))
  const parsed = rawSchema.safeParse(raw)
  const problems = parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
  const token = parsed.success ? readBearerTokenFile('PROVISIONER_TOKEN_FILE', parsed.data.PROVISIONER_TOKEN_FILE, options) : undefined
  if (token !== undefined && !token.ok) problems.push(token.problem)
  if (!parsed.success || token === undefined || !token.ok) return { kind: 'invalid', problems }
  const data = parsed.data
  return {
    kind: 'ok',
    config: {
      token: token.value,
      dockerSocket: data.PROVISIONER_DOCKER_SOCKET ?? DEFAULT_DOCKER_SOCKET,
      image: data.PROVISIONER_IMAGE ?? DEFAULT_TENANT_IMAGE,
      caddyContainer: data.PROVISIONER_CADDY_CONTAINER,
      publicDomain: data.PROVISIONER_PUBLIC_DOMAIN ?? DEFAULT_PUBLIC_DOMAIN,
      host: data.PROVISIONER_HOST ?? DEFAULT_PROVISIONER_HOST,
      port: data.PROVISIONER_PORT ?? DEFAULT_PROVISIONER_PORT,
      maxTenants: data.PROVISIONER_MAX_TENANTS ?? DEFAULT_MAX_TENANTS,
    },
  }
}
