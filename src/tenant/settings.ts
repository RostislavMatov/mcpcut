import { createUpstreamGuard, type UpstreamGuard } from '../net/upstream-guard.js'
import { loadInstallConfigSync, type InstallConfigLoad } from '../setup/load.js'

/**
 * Tenant mode settings (PRD `hosted-accounts`, phase 1, task 1, ADR-0017): the
 * three switches a `tenant` section of `~/.mcpcut/config.json` turns on for a
 * hosted install — refuse stdio servers, reach only public `https` upstreams,
 * and cap how many servers/agents/groups one install can hold — and the
 * agent front's request budget (plan `hosted-path-and-ops`, P7).
 *
 * Resolved once at import, the RESOLVE-ONCE-AT-IMPORT pattern `src/config.ts`
 * uses for `JOURNAL_DIR`: every module that reads `TENANT_SETTINGS` gets a
 * plain, frozen value rather than re-reading and re-parsing the config file on
 * every call.
 *
 * NOT inside `setup/schema.ts`'s IMPORT INVARIANT chain — the opposite
 * direction. Like `src/config.ts` itself, this module sits ABOVE that chain:
 * it is free to import `loadInstallConfigSync` (one-way — `setup/load.js`
 * never imports this file back).
 */

/** Whether stdio servers may be registered/started at all. */
export type StdioServersPolicy = 'allowed' | 'refused'

/** Whether an http(s) upstream may be any address, or only a public https one. */
export type UpstreamsPolicy = 'any' | 'public-https'

/** Per-store ceilings a tenant install enforces on write, and its request budget. */
export interface TenantLimits {
  readonly servers: number
  readonly agents: number
  readonly groups: number
  /**
   * Agent-front requests per second (bursting to twice this) and per sliding
   * 24 hours. `Infinity` off tenant mode: "no limit" stays a number every
   * comparison already understands, and `serve` builds no budget at all for
   * a non-tenant install (`src/cli/serve-budget.ts`), so the unlimited value
   * never reaches the budget's own arithmetic.
   */
  readonly requestsPerSecond: number
  readonly requestsPerDay: number
}

/** What every gate in the plane reads to decide whether it is running hosted, and how. */
export interface TenantSettings {
  /** Whether the install config carries a `tenant` section at all. */
  readonly isTenant: boolean
  readonly stdioServers: StdioServersPolicy
  readonly upstreams: UpstreamsPolicy
  readonly limits: TenantLimits
}

/**
 * Default ceilings on the plane's three stores when nothing narrower applies.
 * Repeated here rather than imported from `registry/constants.js`,
 * `agents/constants.js` and `groups/constants.js` (same reasoning as
 * `MAX_TENANT_*_BOUND` in `setup/constants.ts`): `tests/tenant/settings.test.ts`
 * pins them equal to the real constants, so the two cannot silently drift.
 */
const UNRESTRICTED_MAX_SERVERS = 200
const UNRESTRICTED_MAX_AGENTS = 200
const UNRESTRICTED_MAX_GROUPS = 100

/** No `tenant` section, or a config this process refuses to run at all: prior behavior, byte for byte. */
const UNRESTRICTED_SETTINGS: TenantSettings = Object.freeze({
  isTenant: false,
  stdioServers: 'allowed',
  upstreams: 'any',
  limits: Object.freeze({
    servers: UNRESTRICTED_MAX_SERVERS,
    agents: UNRESTRICTED_MAX_AGENTS,
    groups: UNRESTRICTED_MAX_GROUPS,
    requestsPerSecond: Number.POSITIVE_INFINITY,
    requestsPerDay: Number.POSITIVE_INFINITY,
  }),
})

/**
 * Defaults a PRESENT `tenant` section falls back to for a field it omits, and
 * the preset `setup --tenant` writes (`src/cli/setup-args.ts`) — one table, so
 * "`--tenant`" and "`tenant: {}`" cannot drift apart. Deliberately the STRICT
 * values, not the permissive ones: `tenant: {}` must read as "fully locked
 * down", so an owner cannot leave a field out and reopen it by accident. The
 * numbers are HA7's (PRD `hosted-accounts`).
 */
export interface StrictTenantSection {
  readonly stdioServers: StdioServersPolicy
  readonly upstreams: UpstreamsPolicy
  readonly maxServers: number
  readonly maxAgents: number
  readonly maxGroups: number
  readonly maxRequestsPerSecond: number
  readonly maxRequestsPerDay: number
}

export const STRICT_TENANT_SECTION: StrictTenantSection = Object.freeze({
  stdioServers: 'refused',
  upstreams: 'public-https',
  maxServers: 5,
  maxAgents: 5,
  maxGroups: 2,
  maxRequestsPerSecond: 10,
  maxRequestsPerDay: 10_000,
})

/**
 * Resolves the settings from an already-read install config. Never throws: an
 * `absent` load, an `invalid` one, and an `ok` one with no `tenant` section
 * all mean "not a tenant install". An `invalid` config already stops every
 * command before it runs (`src/cli.ts`'s own config gate, built on
 * `JOURNAL_DIR_RESOLUTION.problem`), so what this function returns for it is
 * moot in practice — chosen for safety (the unrestricted default), not for
 * effect.
 */
export function resolveTenantSettings(load: InstallConfigLoad): TenantSettings {
  const tenant = load.kind === 'ok' ? load.config.tenant : undefined
  if (tenant === undefined) {
    return UNRESTRICTED_SETTINGS
  }

  return Object.freeze({
    isTenant: true,
    stdioServers: tenant.stdioServers ?? STRICT_TENANT_SECTION.stdioServers,
    upstreams: tenant.upstreams ?? STRICT_TENANT_SECTION.upstreams,
    limits: Object.freeze({
      servers: tenant.maxServers ?? STRICT_TENANT_SECTION.maxServers,
      agents: tenant.maxAgents ?? STRICT_TENANT_SECTION.maxAgents,
      groups: tenant.maxGroups ?? STRICT_TENANT_SECTION.maxGroups,
      requestsPerSecond: tenant.maxRequestsPerSecond ?? STRICT_TENANT_SECTION.maxRequestsPerSecond,
      requestsPerDay: tenant.maxRequestsPerDay ?? STRICT_TENANT_SECTION.maxRequestsPerDay,
    }),
  })
}

/** Resolved once per process, at import — see the header. */
export const TENANT_SETTINGS: TenantSettings = resolveTenantSettings(
  loadInstallConfigSync({ env: process.env }),
)

/**
 * The SSRF guard every outbound upstream connection must carry, or
 * `undefined` when this install dials any address (ADR-0017 T4). The ONE
 * place the "guard or not" decision lives: `connect`, the probe and `serve`
 * all ask here, so the three cannot drift apart.
 */
export function upstreamGuardFor(settings: TenantSettings): UpstreamGuard | undefined {
  return settings.upstreams === 'public-https' ? createUpstreamGuard() : undefined
}
