import type { AgentsStore } from '../agents/store.js'
import type { AdminStore } from '../admin/store.js'
import { createGroupsStore } from '../groups/store.js'
import { journalAccessEdit } from '../groups/journal-access-edit.js'
import type { AccessEditInfo } from '../journal/record.js'
import { formatReadableField } from '../journal/format.js'
import { createSessionIndexCache } from '../journal/index-cache.js'
import { searchAllSessions, searchSession } from '../journal/search.js'
import { approveTool, rejectTool } from '../policy/inventory.js'
import { openInventoryStore } from '../policy/inventory-store.js'
import { journalPolicyEdit } from '../policy/edit/journal-edit.js'
import { defaultPolicyFileDeps, readPolicyFileForEdit, writePolicyFile } from '../policy/edit/policy-file.js'
import { readPolicyView } from '../policy/edit/policy-view.js'
import { resolvePolicyEditTarget } from '../policy/edit/write-target.js'
import type { ServerStatusChange } from '../probe/orchestrator.js'
import { createApprovalQueue, type ApprovalQueue } from '../policy/approvals/queue.js'
import type { RegistryStore } from '../registry/store.js'
import type { VaultStore } from '../vault/store.js'
import type { EventHub, UiEvent } from '../ui/events.js'
import { createAdminsHandlers } from '../ui/handlers/admins.js'
import { createAgentsHandlers, type UiAuditEvent } from '../ui/handlers/agents.js'
import { createApprovalsHandlers, DASHBOARD_RECENT_DECISIONS } from '../ui/handlers/approvals.js'
import { createAssetsHandler } from '../ui/handlers/assets.js'
import { createEventsHandler } from '../ui/handlers/events.js'
import { createGroupsHandlers } from '../ui/handlers/groups.js'
import { createJournalHandler, type JournalReadPort } from '../ui/handlers/journal.js'
import { createLoginPage } from '../ui/handlers/login.js'
import {
  createQuarantineHandlers,
  type QuarantineAuditEvent,
} from '../ui/handlers/quarantine.js'
import { createServersHandlers } from '../ui/handlers/servers.js'
import { createServersToolRuleHandlers } from '../ui/handlers/servers-tool-rule.js'
import {
  createServersStatusHandlers,
  type ServerStatusPort,
} from '../ui/handlers/servers-status.js'
import type { UiHandlers } from '../ui/routes.js'
import { composeProbeChain } from './probe-wiring.js'
import type { UiCliWritable } from './ui-constants.js'

/**
 * Composition root for the admin UI's injected handlers (M4 Task 16). It is
 * the ONLY place that knows which concrete store backs which route: the server
 * core (`src/ui/server.ts`) takes an opaque handler map, every Wave-3 handler
 * takes its own narrow port, and this module is the single seam where the two
 * meet. Keeping it out of `ui-cmd.ts` keeps that file about the process
 * lifecycle alone (and both under the size budget).
 *
 * It reads no argv, installs no signal handler and opens no socket — it only
 * builds objects, so a test can assemble the exact production handler map
 * without starting a listener.
 */

export interface UiCompositionDeps {
  /** Journal directory the journal browser reads sessions from. */
  readonly journalDir: string
  /** Root of the file approvals queue (`<journalDir>/approvals` by default). */
  readonly approvalsBaseDir: string
  /** Path of the tool inventory the quarantine page approves/rejects against. */
  readonly inventoryStorePath: string
  readonly adminStore: AdminStore
  readonly agents: AgentsStore
  readonly registry: RegistryStore
  /**
   * `listSecrets` feeds the read-only vault page; `readSecretValues` is used
   * EXCLUSIVELY here in the composition root, to bind the probe engine's
   * `resolveRefs` (ADR-0008) — it is never handed to any `src/ui/**` handler
   * (the architecture test forbids the UI that import, and the narrowing
   * test in `tests/cli/ui-wiring.test.ts` pins it at runtime).
   */
  readonly vault: Pick<VaultStore, 'listSecrets' | 'readSecretValues'>
  /** SSE hub the `/events` handler registers streams with. */
  readonly hub: EventHub
  /** Diagnostics sink; receives the attribution lines for UI mutations. */
  readonly stderr: UiCliWritable
  /** Clock (ms epoch) for approval countdowns. Defaults to `Date.now`. */
  readonly clock?: () => number
  /**
   * Environment and working directory the operator-launched sources panel
   * resolves against (what `serve`/`wrap` started from here would load).
   * Default to the process's own; injectable so tests never read the real
   * `$MCP_JOURNAL_POLICY`.
   */
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
}

export interface UiComposition {
  /** The complete handler map for `createUiServer`. */
  readonly handlers: UiHandlers
  /** The same queue instance the handlers resolve through, for the watcher. */
  readonly queue: ApprovalQueue
  /** Change-sensitive fingerprint of quarantine state, for the watcher. */
  quarantineSignature(): Promise<string>
  /** Waits for every in-flight server probe to settle; starts nothing new. */
  closeProbes(): Promise<void>
}

/**
 * Attribution line for one UI mutation. It carries the acting admin's NAME —
 * never a token, never a session id — so an operator tailing the process log
 * can see who changed what while M5's signed audit record is still ahead.
 */
function auditLine(adminName: string, action: string, target: string): string {
  return `[ui] ${formatReadableField(adminName)} ${action} ${formatReadableField(target)}\n`
}

/** Fingerprint over every quarantined tool and its schema hash, order-stable. */
async function quarantineSignatureOf(storePath: string): Promise<string> {
  const data = await openInventoryStore(storePath).read()
  const entries: string[] = []
  for (const [serverName, inventory] of Object.entries(data.servers)) {
    for (const [toolName, record] of Object.entries(inventory.quarantined)) {
      entries.push(`${serverName}/${toolName}@${record.schemaHash}`)
    }
  }
  return entries.sort().join('\n')
}

/** Sessions the dashboard's recent-decisions walk may touch before it stops. */
const DASHBOARD_DECISIONS_MAX_SESSIONS = 5

/** Wall-clock cap on that walk; the dashboard must stay quick to re-render. */
const DASHBOARD_DECISIONS_TIME_BUDGET_MS = 300

/** The journal read port: the real search + summary-cache layer, no disk logic here. */
function journalReadPort(): JournalReadPort {
  const cache = createSessionIndexCache()
  return {
    listSessions: (dir) => cache.listSessions(dir),
    searchSession: (sessionId, options) => searchSession(sessionId, options),
    searchAllSessions: (options) => searchAllSessions(options),
  }
}

/** The SSE event one settled probe publishes (shape mirrored by `assets/app-js.ts`). */
function statusEventOf(change: ServerStatusChange): UiEvent {
  const { entry } = change
  return {
    event: 'server-status-changed',
    data: {
      server: change.serverName,
      status: entry.status,
      probedAt: entry.probedAt,
      ...(entry.status === 'alive'
        ? { probedVia: entry.probedVia, latencyMs: entry.initializeLatencyMs }
        : { error: entry.error, ...(entry.probedVia !== undefined ? { probedVia: entry.probedVia } : {}) }),
    },
  }
}

interface ProbeComposition {
  readonly port: ServerStatusPort
  close(): Promise<void>
}

/**
 * Composes the probe chain for the UI (M5.5 п.1, ADR-0008): the shared
 * `composeProbeChain` (status store + passive activity + engine + inventory
 * observe + journal fact — one definition for UI and CLI alike, see
 * `probe-wiring.ts`) plus the UI's own SSE event. This is the ONLY place the
 * vault's value-resolution is bound for the UI — the handlers see nothing
 * but `ServerStatusPort`.
 */
function composeProbes(deps: UiCompositionDeps): ProbeComposition {
  const chain = composeProbeChain({
    journalDir: deps.journalDir,
    inventoryStorePath: deps.inventoryStorePath,
    registry: deps.registry,
    readSecretValues: deps.vault.readSecretValues,
    onDiagnostic: (line) => deps.stderr.write(line),
    onStatusChanged: (change) => deps.hub.publish(statusEventOf(change)),
    onError: (error) =>
      deps.stderr.write(`[probe] ${error instanceof Error ? error.message : String(error)}\n`),
    // The one injected clock drives the probe chain too (staleness, probing
    // markers, blink windows) — same discipline as every other subsystem here.
    ...(deps.clock !== undefined ? { now: deps.clock } : {}),
  })
  return {
    port: {
      ensureFresh: (names, initiator) => chain.orchestrator.ensureFresh(names, initiator),
      probeNow: (name, initiator) => chain.orchestrator.probeNow(name, initiator),
      listStatuses: () => chain.statusStore.listStatuses(),
      lastSuccessfulActivity: (name) => chain.activity.lastSuccessfulActivity(name),
    },
    close: () => chain.orchestrator.close(),
  }
}

export function composeUi(deps: UiCompositionDeps): UiComposition {
  const queue = createApprovalQueue({
    baseDir: deps.approvalsBaseDir,
    ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
  })
  const inventory = openInventoryStore(deps.inventoryStorePath)

  const audit = (event: UiAuditEvent): void => {
    deps.stderr.write(auditLine(event.adminName, event.action, event.target))
  }
  const quarantineAudit = (event: QuarantineAuditEvent): void => {
    deps.stderr.write(
      auditLine(event.adminName, `quarantine.${event.action}`, `${event.serverName}/${event.toolName}`),
    )
  }

  // Dashboard summary ports: reads only, each narrowed to the one method the
  // panel needs (same adapter-literal discipline as the servers handlers
  // below). The decisions walk is bounded tightly — it runs on every render
  // of `/`, which the client re-fetches on each queue event.
  const approvals = createApprovalsHandlers({
    queue,
    ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
    summary: {
      listServers: () => deps.registry.listServers(),
      readInventory: () => inventory.read(),
      listAgents: () => deps.agents.listAgents(),
      recentDecisions: () =>
        searchAllSessions({
          dir: deps.journalDir,
          kind: 'decision',
          limit: DASHBOARD_RECENT_DECISIONS,
          maxFiles: DASHBOARD_DECISIONS_MAX_SESSIONS,
          timeBudgetMs: DASHBOARD_DECISIONS_TIME_BUDGET_MS,
        }),
    },
  })
  const quarantine = createQuarantineHandlers({
    readStore: () => inventory.read(),
    approve: (serverName, toolName) => approveTool(serverName, toolName, deps.inventoryStorePath),
    reject: (serverName, toolName) => rejectTool(serverName, toolName, deps.inventoryStorePath),
    audit: quarantineAudit,
  })
  // Adapter literals, not the stores themselves: `ServersHandlersDeps` narrows
  // each port to a `Pick<>` at compile time only, but a store object handed
  // through as-is still carries every method at runtime (e.g. the full
  // `RegistryStore`/`AgentsStore`, or a vault with `readSecretValues`). A
  // handler that only ever calls the declared methods is safe by construction
  // today, but the guarantee should not rest on that discipline holding
  // forever — building an object with only the granted methods makes the
  // Pick<> a runtime fact, not just a type-checker fact.
  const probes = composeProbes(deps)
  const policyEnv = { journalDir: deps.journalDir, env: deps.env ?? process.env, cwd: deps.cwd ?? process.cwd() }
  // The one group store of this process: the servers handlers cascade through
  // it on removal (G6) and the groups surfaces read and write it.
  const groups = createGroupsStore({ journalDir: deps.journalDir })
  // One writer for every `access-edit` record this process produces (G6): the
  // servers cascade and the six group actions share it, so attribution and the
  // drop diagnostic are defined once.
  const writeAccessEdit = (info: AccessEditInfo): Promise<unknown> =>
    journalAccessEdit({
      info,
      dir: deps.journalDir,
      diagnostics: (line) => deps.stderr.write(line),
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
    })
  const servers = createServersHandlers({
    registry: {
      listServers: () => deps.registry.listServers(),
      addServer: (record) => deps.registry.addServer(record),
      updateServer: (record) => deps.registry.updateServer(record),
      removeServer: (name) => deps.registry.removeServer(name),
    },
    agents: {
      listAgents: () => deps.agents.listAgents(),
      ungrantServerEverywhere: (name) => deps.agents.ungrantServerEverywhere(name),
    },
    groups: {
      listGroups: () => groups.listGroups(),
      ungrantServerEverywhere: (name) => groups.ungrantServerEverywhere(name),
    },
    vault: {
      listSecrets: () => deps.vault.listSecrets(),
    },
    audit,
    readInventory: () => inventory.read(),
    probes: probes.port,
    readPolicyView: () => readPolicyView(policyEnv),
    journalAccessEdit: writeAccessEdit,
  })
  // Policy editing (ADR-0009, corrected 2026-08-26): the read view feeds the
  // page, the rule handler is the one HTTP path that writes `policy.json`.
  // The path is bound HERE — the file THIS process resolved through the
  // operator-launched source order (`resolvePolicyEditTarget`, same env/cwd
  // as the view) — and never derived from a request; the journal record goes
  // through the same sink the probe facts use.
  const serversToolRule = createServersToolRuleHandlers({
    resolveEditTarget: () => resolvePolicyEditTarget(policyEnv),
    readPolicyFile: (path) => readPolicyFileForEdit(path, defaultPolicyFileDeps),
    writePolicyFile: (path, document, options) => writePolicyFile(path, document, options, defaultPolicyFileDeps),
    readInventory: () => inventory.read(),
    journal: (edit) =>
      journalPolicyEdit({
        edit,
        dir: deps.journalDir,
        diagnostics: (line) => deps.stderr.write(line),
        ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
      }),
    audit,
  })
  const serversStatus = createServersStatusHandlers({
    probes: probes.port,
    hasServer: async (name) => (await deps.registry.getServer(name)) !== undefined,
  })
  const groupHandlers = createGroupsHandlers({
    groups,
    agents: {
      listAgents: () => deps.agents.listAgents(),
      getAgent: (name) => deps.agents.getAgent(name),
    },
    registry: {
      listServers: () => deps.registry.listServers(),
      getServer: (name) => deps.registry.getServer(name),
    },
    audit,
    journalAccessEdit: writeAccessEdit,
  })
  const agents = createAgentsHandlers({
    agentsStore: deps.agents,
    groups: { listGroups: () => groups.listGroups() },
    audit,
  })
  const admins = createAdminsHandlers({ adminStore: deps.adminStore, audit })

  const handlers: UiHandlers = Object.freeze({
    loginPage: createLoginPage(),
    assets: createAssetsHandler(),
    events: createEventsHandler(deps.hub),
    // The journal's agent dropdown enumerates the registry, not the records:
    // an agent that has not acted yet is still a valid thing to filter for.
    journalPage: createJournalHandler({
      read: journalReadPort(),
      dir: deps.journalDir,
      listAgentNames: async () => (await deps.agents.listAgents()).map((agent) => agent.name),
    }),
    ...approvals,
    ...quarantine,
    ...servers,
    ...groupHandlers,
    ...serversToolRule,
    ...serversStatus,
    ...agents,
    ...admins,
  })

  return Object.freeze({
    handlers,
    queue,
    quarantineSignature: () => quarantineSignatureOf(deps.inventoryStorePath),
    closeProbes: probes.close,
  })
}
