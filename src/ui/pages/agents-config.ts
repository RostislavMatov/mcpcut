import { renderClientConfig, TOKEN_PLACEHOLDER, type ClientConfigForm } from '../../agents/client-config.js'
import { addressNoteOf, type ServeAddress } from '../../setup/serve-address.js'
import { CLI_NAME } from '../../setup/constants.js'
import { html, type Html } from '../html.js'

/**
 * The client config block on the web (ADR-0015, PRD phase 4): the same
 * generator the CLI prints, so the bytes an owner copies are the same bytes
 * wherever the agent was created. Escaping is the `html` template's — the
 * block's quotes and `<token>` come out as entities and read back verbatim.
 *
 * The `<pre>` carries `data-client-config`, never `data-token`: exactly one
 * element per page is the token box.
 */

function configPre(form: ClientConfigForm, address: ServeAddress, token: string): Html {
  const text = renderClientConfig({ serveUrl: address.url, token, form })
  return html`<pre class="ag-config" data-client-config="${form}">${text}</pre>`
}

function addressNote(address: ServeAddress): Html {
  const note = addressNoteOf(address)
  return note === undefined ? html`` : html`<p class="field-hint">${note}</p>`
}

/**
 * Under the token on the page `create` answers with: the stdio block, the note
 * when the address was not remembered, and the native HTTP form folded away.
 * The real token is in both — this response is the one place it is shown.
 */
export function renderTokenPageConfig(address: ServeAddress, token: string): Html {
  return html`<h2>Client config</h2>
    <p class="small dim">Paste into the agent's client. The token is inside — this is the one page that shows it.</p>
    ${configPre('stdio', address, token)}
    ${addressNote(address)}
    <details class="drawer"><summary>HTTP client form (no bridge; token in a header)</summary>
      <div class="drawer-bd">${configPre('http', address, token)}</div>
    </details>`
}

/**
 * The drawer in an agent card on `/agents`: the block with `<token>`, for any
 * role — without the token it is a public shape, not a secret (C3).
 */
export function renderCardConfigDrawer(agentName: string, address: ServeAddress): Html {
  return html`<details class="drawer ag-config-drawer"><summary>client config</summary>
    <div class="drawer-bd">
      ${configPre('stdio', address, TOKEN_PLACEHOLDER)}
      <p class="small dim">Replace ${TOKEN_PLACEHOLDER} with the token shown when the agent was created. HTTP form: <code>${CLI_NAME} agent config ${agentName} --http</code></p>
      ${addressNote(address)}
    </div>
  </details>`
}
