import { HTTP_PROTOCOL_VALUES } from '../../registry/constants.js'
import { html, join, safeUrl, type Html } from '../html.js'
import type { ServerFormValues } from '../server-form.js'
import { csrfField } from './csrf-field.js'

/**
 * The owner-only "Register a server" drawer of the Servers screen: a
 * `<details class="drawer" id="add-server">` the tab bar's `+` opens (and
 * that a plain `#add-server` anchor reaches without JavaScript), holding the
 * same eight-field form the handler parses — field NAMES and values are the
 * contract with `handlers/servers.ts` (`buildCandidate`) and did not change
 * with the redesign; only the fixed vocabularies (transport, protocol) became
 * pill radios instead of a `<select>` / free text.
 */

/** Transport values, in display order; the stdio one is the default choice. */
const TRANSPORT_VALUES = ['stdio', 'http'] as const
const DEFAULT_TRANSPORT = 'stdio'
/** What the form posts for `protocol` when nothing was chosen: the schema default. */
const DEFAULT_PROTOCOL = 'auto'

/** One pill radio; `checked` when it is the current (or default) choice. */
function choice(name: string, value: string, checked: boolean): Html {
  const mark = checked ? html` checked` : html``
  return html`<label class="choice"><input type="radio" name="${name}" value="${value}"${mark}><span>${value}</span></label>`
}

/**
 * A `.choices` group. A blank form (nothing submitted) pre-selects `fallback`,
 * so the post always carries a value — the old `<select>` did the same by
 * showing its first option; a re-rendered rejected form keeps the submitted
 * one. A submitted value outside the vocabulary selects nothing (the error
 * banner already names it).
 */
function choices(name: string, values: readonly string[], current: string, fallback: string): Html {
  const chosen = current === '' ? fallback : current
  return html`<div class="choices">${join(values.map((value) => choice(name, value, value === chosen)))}</div>`
}

function renderStdioGroup(form: ServerFormValues): Html {
  return html`<fieldset class="field-group">
      <legend class="label">stdio</legend>
      <label><span>command</span><input name="command" value="${form.command}" placeholder="uvx" /></label>
      <div class="field">
        <label><span>args</span><input name="args" value="${form.args}" placeholder="mcp-server-postgres,--readonly" /></label>
        <span class="field-hint">comma-separated, one argument per item — an argument that contains a comma cannot be registered from here; use the CLI</span>
      </div>
      <label><span>env — one K=V per line</span><textarea name="env" rows="3" placeholder="PGHOST=db.internal&#10;PGPASSWORD=vault:pg_audit_pw">${form.env}</textarea></label>
    </fieldset>`
}

function renderHttpGroup(form: ServerFormValues): Html {
  return html`<fieldset class="field-group">
      <legend class="label">http</legend>
      <label><span>url</span><input name="url" value="${form.url}" placeholder="https://mcp.example.com/sse" /></label>
      <div class="field">
        <span class="label">protocol</span>
        ${choices('protocol', HTTP_PROTOCOL_VALUES, form.protocol, DEFAULT_PROTOCOL)}
      </div>
      <label><span>headers — one K=V per line</span><textarea name="headers" rows="3" placeholder="Authorization=vault:example_token&#10;X-Tenant=acme">${form.headers}</textarea></label>
    </fieldset>`
}

/**
 * The register drawer. `open` forces it expanded — used when the handler
 * re-renders a rejected submission, so the operator lands on the error and
 * the re-filled form instead of a closed drawer hiding both. `error`, when
 * present, is shown inside the drawer as the alert.
 *
 * `form` has already passed through `echoableServerForm`, which strips the
 * parts the validator called secrets — this template must never be handed
 * raw submitted fields.
 */
export function renderAddDrawer(csrfToken: string, form: ServerFormValues, options: { readonly open: boolean; readonly error?: string }): Html {
  const openAttr = options.open ? html` open` : html``
  const alert = options.error !== undefined ? html`<p role="alert">${options.error}</p>` : html``
  return html`<details class="drawer" id="add-server"${openAttr}>
    <summary>Register a server</summary>
    <div class="drawer-bd">
      ${alert}
      <form method="post" action="/servers/add" class="srv-form">
        ${csrfField(csrfToken)}
        <label><span>name</span><input name="name" value="${form.name}" required placeholder="pg-audit" /></label>
        <div class="field">
          <span class="label">transport</span>
          ${choices('transport', TRANSPORT_VALUES, form.transport, DEFAULT_TRANSPORT)}
          <span class="field-hint">fill the group that matches the transport; fields of the other group are rejected by the schema, not dropped</span>
        </div>
        <div class="srv-form-groups">${renderStdioGroup(form)}${renderHttpGroup(form)}</div>
        <div class="callout">No secrets here. Values may only reference the vault as <code>vault:&lt;name&gt;</code>. The schema rejects secret-looking literals — tokens, keys, long random strings — and the server is not saved.</div>
        <div class="form-actions">
          <a class="btn btn-secondary" href="${safeUrl('/servers')}">Cancel</a>
          <button type="submit">Register</button>
        </div>
      </form>
    </div>
  </details>`
}
