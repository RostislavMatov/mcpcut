import { CLI_NAME } from '../../setup/constants.js'
import type { ActionSpec, SectionSpec } from './types.js'

/**
 * The Home section (mcpcut phase 2, Task 6): where the console opens.
 *
 * It carries one action — `status`, the same command the header's service
 * line is built from — and an intro that names the two commands the console
 * deliberately does NOT run. `connect` and `wrap` are long-lived stdio
 * proxies an AGENT runs, wired to that agent's stdin and stdout; there is no
 * honest way to host them inside a screen that redraws, so Home tells the
 * operator what to type in a shell instead of pretending.
 */

const statusAction: ActionSpec = {
  id: 'status',
  title: 'status',
  minRole: 'viewer',
  command: 'status',
  fields: [],
  argv: () => ['status'],
}

/** The console's first screen: what runs, and how an agent reaches the plane. */
export const HOME_SECTION: SectionSpec = {
  id: 'home',
  title: 'Home',
  minRole: 'viewer',
  intro: [
    'Run an agent through the plane (outside this console):',
    `  ${CLI_NAME} connect <server> --agent <name>   # MCP_AGENT_TOKEN in the agent's environment`,
    `  ${CLI_NAME} wrap --server <name> -- <command…>`,
  ],
  actions: [statusAction],
  refreshActionId: 'status',
}
