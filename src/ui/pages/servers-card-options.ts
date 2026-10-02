import { confirmAgentsOf } from './servers-confirm-rule.js'
import type { ServersView } from './servers.js'
import { ruleControlsOf, toolsNoteOf } from './servers-policy-view.js'
import type { ServerCardOptions, ToolsPanelContext } from './servers-parts.js'

/**
 * What the Servers page hands each tools panel: the per-card options of the
 * registered servers and the panel context of a `wrap` server. Split out of
 * `servers.ts` so the page module stays about layout.
 */

/** The client rule's agent choices for one registered server; an unreadable store offers off / all only. */
function confirmChoicesOf(view: ServersView, serverName: string): Pick<ServerCardOptions, 'confirmAgents' | 'grantExample'> {
  if (view.agentDirectory === undefined) return view.agentsUnavailable === true ? { confirmAgents: { kind: 'unavailable' } } : {}
  const example = view.agentDirectory.known[0]
  return {
    confirmAgents: confirmAgentsOf(view.agentDirectory, serverName),
    ...(example !== undefined ? { grantExample: example } : {}),
  }
}

/** One `ServerCardOptions` per registered server, shared by the card and its modal. */
export function cardOptionsOf(view: ServersView): readonly ServerCardOptions[] {
  const ruleControls = ruleControlsOf(view.policyView, view.canManage)
  const toolsNote = toolsNoteOf(view.policyView)
  return view.servers.map((record) => {
    const tools = view.tools?.get(record.name)
    const status = view.statuses?.get(record.name)
    return {
      record,
      ...(tools !== undefined ? { tools } : {}),
      ...(status !== undefined ? { status } : {}),
      hasInventory: view.tools !== undefined,
      canManage: view.canManage,
      ...(view.canRefresh !== undefined ? { canRefresh: view.canRefresh } : {}),
      ...(view.canRelease !== undefined ? { canRelease: view.canRelease } : {}),
      ...(view.openTools !== undefined ? { toolsOpen: view.openTools === record.name } : {}),
      csrfToken: view.csrfToken,
      ...(ruleControls !== undefined ? { ruleControls } : {}),
      ...(toolsNote !== undefined ? { toolsNote } : {}),
      ...confirmChoicesOf(view, record.name),
    }
  })
}

/** Panel context of a wrap server: the same rule controls, and a client rule with no agent to name. */
export function wrapContextOf(view: ServersView, serverName: string): ToolsPanelContext {
  const ruleControls = ruleControlsOf(view.policyView, view.canManage)
  const toolsNote = toolsNoteOf(view.policyView)
  return {
    serverName,
    csrfToken: view.csrfToken,
    confirmAgents: { kind: 'wrap' },
    ...(view.openTools !== undefined ? { open: view.openTools === serverName } : {}),
    ...(view.canRelease !== undefined ? { canRelease: view.canRelease } : {}),
    ...(ruleControls !== undefined ? { ruleControls } : {}),
    ...(toolsNote !== undefined ? { note: toolsNote } : {}),
  }
}
