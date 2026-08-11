import type { AgentsStore } from '../agents/store.js'
import type { AdminStore } from '../admin/store.js'
import { formatReadableField } from '../journal/format.js'
import { createSessionIndexCache } from '../journal/index-cache.js'
import { searchAllSessions, searchSession } from '../journal/search.js'
import { approveTool, rejectTool } from '../policy/inventory.js'
import { openInventoryStore } from '../policy/inventory-store.js'
import { createApprovalQueue, type ApprovalQueue } from '../policy/approvals/queue.js'
import type { RegistryStore } from '../registry/store.js'
import type { VaultStore } from '../vault/store.js'
import type { EventHub } from '../ui/events.js'
import { createAdminsHandlers } from '../ui/handlers/admins.js'
import { createAgentsHandlers, type UiAuditEvent } from '../ui/handlers/agents.js'
import { createApprovalsHandlers } from '../ui/handlers/approvals.js'
import { createAssetsHandler } from '../ui/handlers/assets.js'
import { createEventsHandler } from '../ui/handlers/events.js'
import { createJournalHandler, type JournalReadPort } from '../ui/handlers/journal.js'
import { createLoginPage } from '../ui/handlers/login.js'
import {
  createQuarantineHandlers,
  type QuarantineAuditEvent,
} from '../ui/handlers/quarantine.js'
import { createServersHandlers } from '../ui/handlers/servers.js'
import type { UiHandlers } from '../ui/routes.js'
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
  readonly vault: Pick<VaultStore, 'listSecrets'>
  /** SSE hub the `/events` handler registers streams with. */
  readonly hub: EventHub
  /** Diagnostics sink; receives the attribution lines for UI mutations. */
  readonly stderr: UiCliWritable
  /** Clock (ms epoch) for approval countdowns. Defaults to `Date.now`. */
  readonly clock?: () => number
}

export interface UiComposition {
  /** The complete handler map for `createUiServer`. */
  readonly handlers: UiHandlers
  /** The same queue instance the handlers resolve through, for the watcher. */
  readonly queue: ApprovalQueue
  /** Change-sensitive fingerprint of quarantine state, for the watcher. */
  quarantineSignature(): Promise<string>
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

/** The journal read port: the real search + summary-cache layer, no disk logic here. */
function journalReadPort(): JournalReadPort {
  const cache = createSessionIndexCache()
  return {
    listSessions: (dir) => cache.listSessions(dir),
    searchSession: (sessionId, options) => searchSession(sessionId, options),
    searchAllSessions: (options) => searchAllSessions(options),
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

  const approvals = createApprovalsHandlers({
    queue,
    ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
  })
  const quarantine = createQuarantineHandlers({
    readStore: () => inventory.read(),
    approve: (serverName, toolName) => approveTool(serverName, toolName, deps.inventoryStorePath),
    reject: (serverName, toolName) => rejectTool(serverName, toolName, deps.inventoryStorePath),
    audit: quarantineAudit,
  })
  const servers = createServersHandlers({
    registry: deps.registry,
    agents: deps.agents,
    vault: deps.vault,
    audit,
  })
  const agents = createAgentsHandlers({ agentsStore: deps.agents, audit })
  const admins = createAdminsHandlers({ adminStore: deps.adminStore, audit })

  const handlers: UiHandlers = Object.freeze({
    loginPage: createLoginPage(),
    assets: createAssetsHandler(),
    events: createEventsHandler(deps.hub),
    journalPage: createJournalHandler({ read: journalReadPort(), dir: deps.journalDir }),
    ...approvals,
    ...quarantine,
    ...servers,
    ...agents,
    ...admins,
  })

  return Object.freeze({
    handlers,
    queue,
    quarantineSignature: () => quarantineSignatureOf(deps.inventoryStorePath),
  })
}
