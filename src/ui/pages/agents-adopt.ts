import { npxCommand } from '../../cli/next-step.js'
import { html, type Html, join, safeUrl } from '../html.js'

/**
 * The `mcpcut adopt` commands on the Agents page (ADR-0018). The page only
 * SHOWS them: `adopt` edits the client config files of the machine it runs on,
 * and the plane never writes a client's file (ADR-0015) — so there is no form
 * and no button, only text to copy into the developer's own shell.
 *
 * The npx form, pinned to this build, is the CLI's own `npxCommand`, so
 * the page and the CLI's hints cannot name different commands. Everything goes through `html`.
 */

/** The adopt forms, in the order a person uses them: look, write, take back. */
const ADOPT_ARGS: readonly string[] = ['adopt', 'adopt --apply', 'adopt --undo']

function adoptCommand(args: string): string {
  return `${npxCommand()} ${args}`
}

/** The first command alone, for the empty state: preview what would change. */
export function adoptPreviewCommand(): string {
  return adoptCommand('adopt')
}

/** Heading, one line of what it does, the three commands, then the next step. */
export function renderAdoptBlock(): Html {
  const commands = ADOPT_ARGS.map((args) => html`<pre class="ag-config" data-adopt-command>${adoptCommand(args)}</pre>`)
  return html`<section class="ag-adopt" aria-label="Adopt servers already configured">
    <h2>Claude Code, Cursor, Claude Desktop on the machine where you run your client</h2>
    <p class="small dim"><code>adopt</code> puts the MCP servers already configured there behind mcpcut. The first command only shows the change; <code>--apply</code> writes it and keeps a copy of each file; <code>--undo</code> puts them back. Run them in a terminal on the machine where you run your client.</p>
    ${join(commands)}
    <p class="small dim">Then restart the client; its calls appear in the <a href="${safeUrl('/journal')}">Journal</a>.</p>
  </section>`
}
