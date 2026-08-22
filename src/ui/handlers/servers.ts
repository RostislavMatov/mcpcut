import { formatPolicyErrors } from '../../policy/load.js'
import { parseServerRecord } from '../../registry/schema.js'
import type { RegistryStore } from '../../registry/store.js'
import type { AgentsStore } from '../../agents/store.js'
import type { VaultStore } from '../../vault/store.js'
import type { InventoryStoreData } from '../../policy/inventory-store.js'
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_OK,
  HTTP_STATUS_SEE_OTHER,
} from '../constants.js'
import { parseBodyFields, headerValue, type UiHandler, type UiRequestContext, type UiResult } from '../routes.js'
import { echoableServerForm, splitKeyValueLine } from '../server-form.js'
import type { CurrentAdmin } from '../pages/layout.js'
import {
  renderAddConfirm,
  renderRemoveWarning,
  renderServersPage,
  renderVaultPage,
  toServerToolsByName,
  type ServersView,
  type VaultView,
} from '../pages/servers.js'

/**
 * Handlers for the server registry and the read-only vault view (M4 Task 13).
 *
 * Layering invariant: NOTHING here reaches the vault's value-reading path — the
 * vault handler reads only `listSecrets()`, names and dates, so a secret value
 * has no route to the browser. This is enforced mechanically for the WHOLE UI
 * layer, not just this file: `tests/architecture/imports.test.ts` fails if any
 * `src/ui/**` module imports the vault's secret-resolution module or so much as
 * names its value-reading export (the file-local source check in
 * `tests/ui/servers.test.ts` remains as the close-range regression guard — and
 * is why neither that module path nor that export is spelled out here).
 * Registry mutations reuse
 * the SAME validation as the CLI (`parseServerRecord`), which rejects any
 * secret-shaped literal with the same "put it in the vault" hint, and every
 * mutation is attributed to the acting admin via the optional `audit` sink
 * (`actor: 'ui'` + `adminName`).
 */

/** One attributed UI mutation, for the audit sink. */
export interface UiAuditEvent {
  readonly actor: 'ui'
  readonly adminName: string
  readonly action: string
  readonly target: string
}

export interface ServersHandlersDeps {
  readonly registry: Pick<RegistryStore, 'listServers' | 'addServer' | 'removeServer'>
  readonly agents: Pick<AgentsStore, 'listAgents'>
  readonly vault: Pick<VaultStore, 'listSecrets'>
  /** Receives an attributed record of each successful mutation. Optional. */
  readonly audit?: (event: UiAuditEvent) => void
  /**
   * Read port for the tool inventory (approved + quarantined tools per
   * server). Optional and read-only: with it the servers page lists each
   * server's tools and counts; without it the page renders the registry alone.
   * A read failure is the caller's (it surfaces as a 500 through the server
   * core, as on the dashboard), never a page that silently shows no tools.
   */
  readonly readInventory?: () => Promise<InventoryStoreData>
}

export interface ServersHandlers {
  readonly serversPage: UiHandler
  readonly serversAdd: UiHandler
  readonly serversRemove: UiHandler
  readonly vaultPage: UiHandler
}

/** The signed-in admin as the layout's untrusted-for-render nav model. */
function currentAdminOf(ctx: UiRequestContext): CurrentAdmin {
  return { name: ctx.session?.adminName ?? '', role: ctx.session?.role ?? '' }
}

function csrfTokenOf(ctx: UiRequestContext): string {
  return ctx.session?.csrfToken ?? ''
}

function fieldsOf(ctx: UiRequestContext): Readonly<Record<string, string>> {
  return parseBodyFields(ctx.body, headerValue(ctx.headers, 'content-type'))
}

function redirect(location: string): UiResult {
  return { kind: 'response', status: HTTP_STATUS_SEE_OTHER, headers: { location } }
}

/** Parses a `K=V` per line block into a plain map; blank lines ignored. */
function parseKeyValueLines(block: string | undefined): Record<string, string> | undefined {
  if (block === undefined || block.trim() === '') return undefined
  const map: Record<string, string> = Object.create(null) as Record<string, string>
  for (const rawLine of block.split(/\r?\n/)) {
    const pair = splitKeyValueLine(rawLine)
    if (pair === null) continue
    map[pair.key] = pair.value
  }
  return Object.keys(map).length > 0 ? map : undefined
}

/**
 * Assembles a raw candidate record from the add form. Every provided field is
 * included even if it does not belong to the chosen transport, so the strict
 * schema reports a precise "unrecognized key" instead of silently dropping it —
 * exactly the CLI's `buildCandidate` behaviour.
 */
function buildCandidate(fields: Readonly<Record<string, string>>): Record<string, unknown> {
  const candidate: Record<string, unknown> = { name: fields.name ?? '', transport: fields.transport ?? '' }
  if (fields.command !== undefined && fields.command !== '') candidate.command = fields.command
  if (fields.args !== undefined && fields.args !== '') candidate.args = fields.args.split(',')
  const env = parseKeyValueLines(fields.env)
  if (env !== undefined) candidate.env = env
  if (fields.url !== undefined && fields.url !== '') candidate.url = fields.url
  const headers = parseKeyValueLines(fields.headers)
  if (headers !== undefined) candidate.headers = headers
  if (fields.protocol !== undefined && fields.protocol !== '') candidate.protocol = fields.protocol
  return candidate
}

export function createServersHandlers(deps: ServersHandlersDeps): ServersHandlers {
  /**
   * The page's base view: registry + session + (when the port is wired) the
   * per-server tools. Reads run concurrently; either failing fails the page.
   */
  async function baseView(ctx: UiRequestContext): Promise<ServersView> {
    const [servers, inventory] = await Promise.all([
      deps.registry.listServers(),
      deps.readInventory?.() ?? Promise.resolve(undefined),
    ])
    const query = ctx.query.get('q') ?? ''
    return {
      servers,
      canManage: ctx.session?.role === 'owner',
      csrfToken: csrfTokenOf(ctx),
      currentAdmin: currentAdminOf(ctx),
      ...(inventory !== undefined ? { tools: toServerToolsByName(inventory) } : {}),
      ...(query !== '' ? { query } : {}),
    }
  }

  async function serversPage(ctx: UiRequestContext): Promise<UiResult> {
    const body = renderServersPage(await baseView(ctx))
    return { kind: 'response', status: HTTP_STATUS_OK, body }
  }

  /**
   * A rejected registration: 400 with the reason AND the form re-filled. The
   * values go through `echoableServerForm` first, so whatever the validator
   * called a secret is dropped instead of being handed back to the browser.
   */
  async function rejectedAdd(
    ctx: UiRequestContext,
    fields: Readonly<Record<string, string>>,
    error: string,
  ): Promise<UiResult> {
    const body = renderServersPage({
      ...(await baseView(ctx)),
      error,
      form: echoableServerForm(fields),
    })
    return { kind: 'response', status: HTTP_STATUS_BAD_REQUEST, body }
  }

  async function serversAdd(ctx: UiRequestContext): Promise<UiResult> {
    const fields = fieldsOf(ctx)
    const parsed = parseServerRecord(buildCandidate(fields))
    if (!parsed.ok) {
      return rejectedAdd(ctx, fields, formatPolicyErrors(parsed.error).join('; '))
    }
    // Validation runs BEFORE the interstitial, so confirming is never a way
    // past it — and the page shows the record the schema actually accepted,
    // not the raw form, so what is confirmed is what will be stored.
    if (fields.confirm !== 'true') {
      const body = renderAddConfirm({
        record: parsed.record,
        fields,
        csrfToken: csrfTokenOf(ctx),
        currentAdmin: currentAdminOf(ctx),
      })
      return { kind: 'response', status: HTTP_STATUS_OK, body }
    }
    try {
      await deps.registry.addServer(parsed.record)
    } catch (error: unknown) {
      return rejectedAdd(ctx, fields, error instanceof Error ? error.message : String(error))
    }
    audit(ctx, 'server.add', parsed.record.name)
    return redirect('/servers')
  }

  async function serversRemove(ctx: UiRequestContext): Promise<UiResult> {
    const fields = fieldsOf(ctx)
    const name = fields.name ?? ''
    const confirmed = fields.confirm === 'true'
    if (!confirmed) {
      const holders = await agentsGranting(deps.agents, name)
      if (holders.length > 0) {
        const body = renderRemoveWarning({
          serverName: name,
          agents: holders,
          csrfToken: csrfTokenOf(ctx),
          currentAdmin: currentAdminOf(ctx),
        })
        return { kind: 'response', status: HTTP_STATUS_OK, body }
      }
    }
    const result = await deps.registry.removeServer(name)
    if (result.status === 'not-found') {
      return { kind: 'response', status: HTTP_STATUS_NOT_FOUND, body: 'unknown server' }
    }
    audit(ctx, 'server.remove', result.record.name)
    return redirect('/servers')
  }

  async function vaultPage(ctx: UiRequestContext): Promise<UiResult> {
    const listed = await deps.vault.listSecrets()
    const view: VaultView = {
      csrfToken: csrfTokenOf(ctx),
      currentAdmin: currentAdminOf(ctx),
      ...vaultViewFields(listed),
    }
    return { kind: 'response', status: HTTP_STATUS_OK, body: renderVaultPage(view) }
  }

  function audit(ctx: UiRequestContext, action: string, target: string): void {
    deps.audit?.({ actor: 'ui', adminName: ctx.session?.adminName ?? '', action, target })
  }

  return { serversPage, serversAdd, serversRemove, vaultPage }
}

/** Names of active (non-revoked) agents holding a grant for `serverName`. */
async function agentsGranting(
  agents: Pick<AgentsStore, 'listAgents'>,
  serverName: string,
): Promise<readonly string[]> {
  const all = await agents.listAgents()
  return all
    .filter((agent) => agent.revokedAt === undefined && Object.hasOwn(agent.grants, serverName))
    .map((agent) => agent.name)
}

/** Maps a `listSecrets` result to the value-free vault view fields. */
function vaultViewFields(
  listed: Awaited<ReturnType<VaultStore['listSecrets']>>,
): Pick<VaultView, 'secrets' | 'notice'> {
  if (listed.status === 'listed') return { secrets: listed.secrets }
  if (listed.status === 'not-initialized') return { notice: 'Vault is not initialized.' }
  return { notice: `Vault is unavailable: ${listed.message}` }
}
