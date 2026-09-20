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

/**
 * "A way to disconnect from the server and fill in another server" (owner
 * request, 2026-09-20). Visible ONLY on a remote console (`requires:
 * 'remote'`) — there is nothing to disconnect from on the local one — and
 * confirm-free: leaving a service you are looking at takes nothing away from
 * it, unlike `Services ▸ stop`. `command`/`subcommand` name no real CLI
 * command; `argv` is never called (`disconnectsConsole`), and the catalogue
 * parity test (`tests/tui/catalogue-parity.test.ts`) lists it explicitly as a
 * console-only action rather than pretending it describes `mcpcut disconnect`.
 */
const disconnectAction: ActionSpec = {
  id: 'disconnect',
  title: 'disconnect',
  minRole: 'viewer',
  command: 'disconnect',
  requires: 'remote',
  disconnectsConsole: true,
  fields: [],
  argv: () => [],
  hint: 'forget this service and connect to another',
}

/** The part of Home's intro that holds on every install, whoever supervises it. */
const RUN_AN_AGENT_LINES: readonly string[] = [
  'Run an agent through the plane (outside this console):',
  `  ${CLI_NAME} connect <server> --agent <name>`,
  `  ${CLI_NAME} wrap --server <name> -- <command…>`,
  'MCP_AGENT_TOKEN goes in the agent’s own environment.',
]

/** The console's first screen: what runs, and how an agent reaches the plane. */
export const HOME_SECTION: SectionSpec = {
  id: 'home',
  title: 'Home',
  minRole: 'viewer',
  intro: [...RUN_AN_AGENT_LINES, 'A service marked ○ in the header: Services ▸ start.'],
  // Under `supervisor: external` there is no `Services ▸ start` to press (Q32).
  // Two lines, not one: the pane beside the action column is 54 columns wide.
  externalIntro: [
    ...RUN_AN_AGENT_LINES,
    'Services are run by compose or systemd',
    '(supervisor: external): mcpcut only reports.',
  ],
  actions: [statusAction, disconnectAction],
  refreshActionId: 'status',
}
