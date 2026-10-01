import { cliCommand } from './next-step.js'

/**
 * The block at the very top of `mcpcut --help`: the commands of the
 * Quick start (README), in the same order and the same form. The full list
 * is 150+ lines; a newcomer reads this much and starts. `cliCommand()` makes
 * the rows paste-ready for an npx user too.
 */
const COMMAND = cliCommand()

export const START_HERE = `Start here:
  ${COMMAND} adopt
      Put the MCP servers you already have in Claude Code, Cursor or Claude Desktop
      behind mcpcut (shows the change; --apply writes it)
  ${COMMAND} wrap --server <name> -- <your server command>
      Or journal one MCP server by hand (nothing to set up first)
  ${COMMAND} sessions
      List what was journaled
  ${COMMAND} show <id>
      Every request and response of one session, secrets redacted
  ${COMMAND} approvals list
  ${COMMAND} approvals approve <id>
      Calls held by a policy wait here; approve from another terminal
  ${COMMAND} export --report --out ./report
  ${COMMAND} verify --report ./report
      Export the history and check it offline

<command> --help shows one command; the full list follows.

`
