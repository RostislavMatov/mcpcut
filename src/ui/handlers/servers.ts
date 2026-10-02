import { formatPolicyErrors } from '../../policy/load.js'
import { parseServerRecord } from '../../registry/schema.js'
import type { RegistryStore } from '../../registry/store.js'
import { TENANT_SETTINGS, type TenantSettings } from '../../tenant/settings.js'
import type { VaultStore } from '../../vault/store.js'
import type { InventoryStoreData } from '../../policy/inventory-store.js'
import type { PolicyView } from '../../policy/edit/policy-view.js'
import { HTTP_STATUS_BAD_REQUEST, HTTP_STATUS_NOT_FOUND, HTTP_STATUS_OK } from '../constants.js'
import { roleSatisfies } from '../authz.js'
import type { UiHandler, UiRequestContext, UiResult } from '../routes.js'
import {
  MISSING_SERVER_NAME_MESSAGE,
  refusalNotice,
  SERVERS_LIST,
  UNKNOWN_SERVER_MESSAGE,
} from './refusal-notice.js'
import { csrfTokenOf, currentAdminOf, fieldsOf } from './request-helpers.js'
import { journalServerChange, serverChangeApplied } from './servers-journal.js'
import {
  agentsGranting,
  createServersRemoveHandler,
  groupsGranting,
  type ServersRemoveDeps,
} from './servers-remove.js'
import {
  probeInitiatorOf,
  startProbe,
  statusesViewOf,
  type ServerStatusPort,
} from './servers-status.js'
import { effectiveGrantsOf } from '../../agents/effective.js'
import type { AgentDirectory } from '../pages/servers-confirm-rule.js'
import { echoableServerForm, serverRecordToForm, EMPTY_SERVER_FORM } from '../server-form.js'
import { buildCandidate } from './servers-candidate.js'
import {
  renderAddConfirm,
  renderServersPage,
  renderVaultPage,
  toServerToolsByName,
  TOOLS_QUERY_PARAM,
  type AddConfirmView,
  type ServerDrawerState,
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
 * mutation is attributed to the acting admin twice: on the optional `audit`
 * sink (`actor: 'ui'` + `adminName`) and as an `access-edit` journal record
 * (`handlers/servers-journal.ts`) — the line an exported report can show.
 */

/** One attributed UI mutation, for the audit sink. */
export interface UiAuditEvent {
  readonly actor: 'ui'
  readonly adminName: string
  readonly action: string
  readonly target: string
}

export interface ServersHandlersDeps extends ServersRemoveDeps {
  readonly registry: Pick<RegistryStore, 'listServers' | 'addServer' | 'updateServer' | 'removeServer'>
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
  /**
   * Probe port (M5.5 п.1, ADR-0008), injected by `cli/ui-wiring.ts`. Optional
   * and side-effectful by design: with it the servers page shows per-server
   * status dots, lazily freshens stale statuses on every view (O2/O5) and
   * fires the automatic registration probe after a confirmed add (O8);
   * without it the page renders exactly as before M5.5.
   */
  readonly probes?: ServerStatusPort
  /**
   * The policy read for the UI (ADR-0009), injected by `cli/ui-wiring.ts`.
   * Optional: with it every tool shows its effective rule and the owner gets
   * the rule controls; without it the page renders exactly as before.
   */
  readonly readPolicyView?: () => Promise<PolicyView>
  /**
   * Tenant mode settings (ADR-0017, task 8), injected by `cli/ui-wiring.ts`.
   * Defaults to `TENANT_SETTINGS` — same optional-dependency shape as the
   * registry/agents/groups stores and `serve-upstream.ts` use for the same
   * setting, so a test can drive it directly without going through the
   * install config.
   */
  readonly tenant?: TenantSettings
}

export interface ServersHandlers {
  readonly serversPage: UiHandler
  readonly serversAdd: UiHandler
  readonly serversEdit: UiHandler
  readonly serversRemove: UiHandler
  readonly vaultPage: UiHandler
}

export function createServersHandlers(deps: ServersHandlersDeps): ServersHandlers {
  /**
   * The page's base view: registry + session + (when the port is wired) the
   * per-server tools. Reads run concurrently; either failing fails the page.
   */
  async function baseView(ctx: UiRequestContext): Promise<ServersView> {
    const [servers, inventory, policyView, agentDirectory] = await Promise.all([
      deps.registry.listServers(),
      deps.readInventory?.() ?? Promise.resolve(undefined),
      deps.readPolicyView?.() ?? Promise.resolve(undefined),
      policyViewWantsAgents(deps) ? agentDirectoryOf(deps) : Promise.resolve(undefined),
    ])
    const query = ctx.query.get('q') ?? ''
    const openTools = ctx.query.get(TOOLS_QUERY_PARAM) ?? ''
    const names = servers.map((record) => record.name)
    const policy = policyView?.status === 'loaded' ? policyView.policy : undefined
    const tenant = deps.tenant ?? TENANT_SETTINGS
    const wrapServers = inventory === undefined || tenant.isTenant ? [] : wrapServerNamesOf(inventory, names)
    return {
      servers,
      canManage: ctx.session?.role === 'owner',
      canRefresh: ctx.session !== undefined && roleSatisfies(ctx.session.role, 'operator'),
      canRelease: ctx.session !== undefined && roleSatisfies(ctx.session.role, 'operator'),
      csrfToken: csrfTokenOf(ctx),
      currentAdmin: currentAdminOf(ctx),
      tenant,
      viewMode: ctx.query.get('view') === 'list' ? 'list' : 'grid',
      ...(inventory !== undefined ? { tools: toServerToolsByName(inventory, policy) } : {}),
      ...(policyView !== undefined ? { policyView } : {}),
      ...(agentDirectory !== undefined ? { agentDirectory } : {}),
      ...(wrapServers.length > 0 ? { wrapServers } : {}),
      ...(deps.probes !== undefined
        ? { statuses: await statusesViewOf(deps.probes, names) }
        : {}),
      ...(query !== '' ? { query } : {}),
      ...(openTools !== '' ? { openTools } : {}),
    }
  }

  /**
   * The drawer state a GET asked for: `?edit=<name>` prefills the edit form
   * from the STORED record (schema-clean, so echoable as-is); `?add=1` opens
   * the blank register form — the no-JS path behind the tab bar's `+`.
   * An unknown edit name falls back to the closed drawer rather than an
   * error page: the list below still shows what does exist.
   */
  function drawerFromQuery(ctx: UiRequestContext, view: ServersView): ServerDrawerState | undefined {
    if (!view.canManage) return undefined
    const editName = ctx.query.get('edit')
    if (editName !== null && editName !== '') {
      const record = view.servers.find((server) => server.name === editName)
      if (record === undefined) return undefined
      return { mode: 'edit', open: true, form: serverRecordToForm(record), editName: record.name }
    }
    if (ctx.query.get('add') !== null) {
      return { mode: 'add', open: true, form: EMPTY_SERVER_FORM }
    }
    return undefined
  }

  async function serversPage(ctx: UiRequestContext): Promise<UiResult> {
    const view = await baseView(ctx)
    const drawer = drawerFromQuery(ctx, view)
    const body = renderServersPage({ ...view, ...(drawer !== undefined ? { drawer } : {}) })
    // Lazy trigger (O2/O5): ANY view — including a viewer's — freshens stale
    // statuses, deliberately NOT awaited: the page answers from what is
    // stored, the probe's outcome arrives over SSE or on the next load.
    // `ensureFresh` contains per-server faults itself; the catch covers only
    // a failed start (e.g. an unreadable status document).
    if (deps.probes !== undefined) {
      void deps.probes
        .ensureFresh(
          view.servers.map((record) => record.name),
          probeInitiatorOf(ctx, 'lazy'),
        )
        .catch(() => undefined)
    }
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
      drawer: { mode: 'add', open: true, form: echoableServerForm(fields), error },
    })
    return { kind: 'response', status: HTTP_STATUS_BAD_REQUEST, body }
  }

  /** A rejected edit: like `rejectedAdd`, but the drawer stays in edit mode. */
  async function rejectedEdit(
    ctx: UiRequestContext,
    fields: Readonly<Record<string, string>>,
    original: string,
    error: string,
  ): Promise<UiResult> {
    const body = renderServersPage({
      ...(await baseView(ctx)),
      error,
      drawer: {
        mode: 'edit',
        open: true,
        form: echoableServerForm({ ...fields, name: original }),
        editName: original,
        error,
      },
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
        ...(await grantedToFields(parsed.record.name)),
      })
      return { kind: 'response', status: HTTP_STATUS_OK, body }
    }
    try {
      await deps.registry.addServer(parsed.record)
    } catch (error: unknown) {
      return rejectedAdd(ctx, fields, error instanceof Error ? error.message : String(error))
    }
    const name = parsed.record.name
    audit(ctx, 'server.add', name)
    // The record of WHO registered goes before the probe RUNS the command
    // (same order as the CLI's `runServerAdd`). The write has landed, so a
    // dropped record is a warning on the success page, never a 500.
    const journal = await journalServerChange(deps.journalAccessEdit, ctx, {
      action: 'server.add',
      server: name,
    })
    // O8: ONE automatic probe (with tools/list) right after the human
    // confirmed exactly this command line — never before the registry write,
    // never awaited, attributed to the confirming admin.
    if (deps.probes !== undefined) {
      startProbe(deps.probes, name, probeInitiatorOf(ctx, 'registration'))
    }
    return serverChangeApplied(ctx, `registered ${name}`, journal)
  }

  /**
   * The `grantedTo` half of the add confirmation (T3): who already grants this
   * NAME, which the registry knows nothing about. Absent when nothing does, so
   * the ordinary registration shows the ordinary page. A read failure here
   * would fail the confirmation, which is the right way round: the operator
   * must not confirm a registration whose consequences could not be checked.
   */
  async function grantedToFields(
    name: string,
  ): Promise<Pick<AddConfirmView, 'grantedTo'> | Record<string, never>> {
    const [agents, groups] = await Promise.all([
      agentsGranting(deps.agents, name),
      groupsGranting(deps.groups, name),
    ])
    if (agents.length === 0 && groups.length === 0) return {}
    return { grantedTo: { agents, groups } }
  }

  /**
   * Saves an edited definition. The name is NOT editable: whatever the form
   * posts, the candidate is built with the ORIGINAL name (grants, inventory
   * and quarantine state are keyed by it — see `registry/store.ts
   * updateServer`). Validation and the confirmation interstitial mirror the
   * add flow: editing a stdio command is the same remote-code-execution power
   * as registering one — which is also why it leaves the same kind of journal
   * record (`server.update`), with the same dropped-record warning.
   */
  async function serversEdit(ctx: UiRequestContext): Promise<UiResult> {
    const fields = fieldsOf(ctx)
    const original = fields.original ?? ''
    if (original === '') {
      return refusalNotice(ctx, HTTP_STATUS_BAD_REQUEST, MISSING_SERVER_NAME_MESSAGE, SERVERS_LIST)
    }
    const locked: Record<string, string> = { ...fields, name: original }
    const parsed = parseServerRecord(buildCandidate(locked))
    if (!parsed.ok) {
      return rejectedEdit(ctx, fields, original, formatPolicyErrors(parsed.error).join('; '))
    }
    if (fields.confirm !== 'true') {
      const body = renderAddConfirm({
        record: parsed.record,
        fields: locked,
        csrfToken: csrfTokenOf(ctx),
        currentAdmin: currentAdminOf(ctx),
        mode: 'edit',
      })
      return { kind: 'response', status: HTTP_STATUS_OK, body }
    }
    // Tenant mode (`registry/store.ts`) can refuse a record that passed
    // schema validation above — a stdio edit while `stdioServers` is
    // `refused`, or a non-`https` url while `upstreams` is `public-https` —
    // so this write needs the same try/catch as `serversAdd`: a refusal is a
    // rejected form, never an unhandled 500.
    let result: Awaited<ReturnType<typeof deps.registry.updateServer>>
    try {
      result = await deps.registry.updateServer(parsed.record)
    } catch (error: unknown) {
      return rejectedEdit(ctx, fields, original, error instanceof Error ? error.message : String(error))
    }
    if (result.status === 'not-found') {
      return refusalNotice(ctx, HTTP_STATUS_NOT_FOUND, UNKNOWN_SERVER_MESSAGE, SERVERS_LIST)
    }
    const name = result.record.name
    audit(ctx, 'server.update', name)
    const journal = await journalServerChange(deps.journalAccessEdit, ctx, {
      action: 'server.update',
      server: name,
    })
    return serverChangeApplied(ctx, `updated ${name}`, journal)
  }

  // The removal flow (interstitial + G6 cascade + journal) lives in its own
  // module: it is the one flow here with a failure story of its own.
  const serversRemove = createServersRemoveHandler(deps)

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

  return { serversPage, serversAdd, serversEdit, serversRemove, vaultPage }
}

/** Only a page with a policy port renders the client control, so only then are the agents read. */
function policyViewWantsAgents(deps: ServersHandlersDeps): boolean {
  return deps.readPolicyView !== undefined
}

/**
 * Who can be asked to confirm: every non-revoked agent, and per server the
 * agents whose EFFECTIVE grants (personal, else the groups') name it — the
 * same reading the gate authorizes with. Sorted by name for a stable page.
 */
async function agentDirectoryOf(deps: ServersHandlersDeps): Promise<AgentDirectory> {
  const [agents, groups] = await Promise.all([deps.agents.listAgents(), deps.groups.listGroups()])
  const live = agents.filter((agent) => agent.revokedAt === undefined).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const grantedBy = new Map<string, string[]>()
  for (const agent of live) {
    for (const serverName of Object.keys(effectiveGrantsOf(agent, groups).grants)) {
      grantedBy.set(serverName, [...(grantedBy.get(serverName) ?? []), agent.name])
    }
  }
  return { known: live.map((agent) => agent.name), grantedBy }
}

/** Inventory servers that are not in the registry: the ones that run under `wrap` here. Sorted. */
function wrapServerNamesOf(inventory: InventoryStoreData, registered: readonly string[]): readonly string[] {
  const known = new Set(registered)
  return Object.keys(inventory.servers).filter((name) => !known.has(name)).sort()
}

/** Maps a `listSecrets` result to the value-free vault view fields. */
function vaultViewFields(
  listed: Awaited<ReturnType<VaultStore['listSecrets']>>,
): Pick<VaultView, 'secrets' | 'notice'> {
  if (listed.status === 'listed') return { secrets: listed.secrets }
  if (listed.status === 'not-initialized') return { notice: 'Vault is not initialized.' }
  return { notice: `Vault is unavailable: ${listed.message}` }
}
