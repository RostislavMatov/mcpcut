import { HTTP_PROTOCOL_VALUES } from '../../registry/constants.js'
import { html, join, safeUrl, type Html } from '../html.js'
import type { ServerFormValues } from '../server-form.js'
import { csrfField } from './csrf-field.js'

/**
 * The owner-only server form drawer of the Servers screen — since the McpCut
 * Servers.dc.html port, a MODAL overlay: still a `<details class="drawer"
 * id="add-server">` underneath (the tab bar's `+` opens it via
 * `data-open-details`, and `/servers?add=1` / `/servers?edit=<name>` render it
 * open server-side for the no-JS path), but its summary is visually hidden —
 * the design has no in-page "register" button — and `[open]` styles it as the
 * centred overlay form.
 *
 * One form serves two modes:
 *  - `add`: posts to `/servers/add`, everything editable;
 *  - `edit`: posts to `/servers/edit` with the ORIGINAL name in a hidden
 *    field; the name input is read-only because the name is the registry key
 *    that grants, inventory and quarantine state all hang off — renaming
 *    would silently orphan them (`registry/store.ts updateServer`).
 *
 * Field NAMES stay the contract with `handlers/servers.ts` (`buildCandidate`).
 * `args` is a textarea, ONE ARGUMENT PER LINE (the design's row model): an
 * argument may contain commas or spaces and stays one argument.
 */

/** Transport values, in display order; the stdio one is the default choice. */
const TRANSPORT_VALUES = ['stdio', 'http'] as const
const DEFAULT_TRANSPORT = 'stdio'
/** What the form posts for `protocol` when nothing was chosen: the schema default. */
const DEFAULT_PROTOCOL = 'auto'

/** The drawer's mode and state, built by the handler. */
export interface ServerDrawerOptions {
  readonly mode: 'add' | 'edit'
  /** Forces the drawer open (rejected submission, `?add=1`, `?edit=`). */
  readonly open: boolean
  readonly error?: string
  /** `edit` only: the immutable name of the server being edited. */
  readonly editName?: string
}

/** One pill radio; `checked` when it is the current (or default) choice. */
function choice(name: string, value: string, checked: boolean): Html {
  const mark = checked ? html` checked` : html``
  return html`<label class="choice"><input type="radio" name="${name}" value="${value}"${mark}><span>${value}</span></label>`
}

/** A `.choices` group; a blank form pre-selects `fallback` so the post always carries a value. */
function choices(name: string, values: readonly string[], current: string, fallback: string): Html {
  const chosen = current === '' ? fallback : current
  return html`<div class="choices">${join(values.map((value) => choice(name, value, value === chosen)))}</div>`
}

/**
 * The stdio group. Hidden by CSS (`:has`) while the http transport is the
 * checked one — the fields are still posted either way, and the strict schema
 * rejects fields of the other transport rather than dropping them.
 */
function renderStdioGroup(form: ServerFormValues): Html {
  return html`<fieldset class="field-group grp grp-stdio">
      <legend class="label">stdio</legend>
      <label><span>command</span><input name="command" value="${form.command}" placeholder="uvx" /></label>
      <div class="field">
        <label><span>args — one per line</span><textarea name="args" rows="3" placeholder="mcp-server-postgres&#10;--readonly">${form.args}</textarea></label>
        <span class="field-hint">one argument per line — spaces and commas stay inside the argument, never joined</span>
      </div>
      <label><span>env — one K=V per line</span><textarea name="env" rows="3" placeholder="PGHOST=db.internal&#10;PGPASSWORD=vault:pg_audit_pw">${form.env}</textarea></label>
    </fieldset>`
}

function renderHttpGroup(form: ServerFormValues): Html {
  return html`<fieldset class="field-group grp grp-http">
      <legend class="label">http</legend>
      <label><span>url</span><input name="url" value="${form.url}" placeholder="https://mcp.example.com/sse" /></label>
      <div class="field">
        <span class="label">protocol</span>
        ${choices('protocol', HTTP_PROTOCOL_VALUES, form.protocol, DEFAULT_PROTOCOL)}
      </div>
      <label><span>headers — one K=V per line</span><textarea name="headers" rows="3" placeholder="Authorization=vault:example_token&#10;X-Tenant=acme">${form.headers}</textarea></label>
    </fieldset>`
}

function renderNameField(form: ServerFormValues, options: ServerDrawerOptions): Html {
  if (options.mode === 'edit') {
    return html`<div class="field">
      <label><span>name</span><input name="name_shown" value="${options.editName ?? form.name}" readonly aria-describedby="name-locked-hint" /></label>
      <span class="field-hint" id="name-locked-hint">the name is the registry key — grants and quarantine state hang off it; remove and register anew to rename</span>
    </div>`
  }
  return html`<div class="field">
    <label><span>name</span><input name="name" value="${form.name}" required placeholder="pg-audit" /></label>
    <span class="field-hint">lowercase, digits and hyphens · up to 64 chars</span>
  </div>`
}

/**
 * The modal form. `form` has already passed through `echoableServerForm` (or
 * was built from the stored — schema-clean — record in edit mode); this
 * template must never be handed raw submitted fields.
 */
export function renderServerDrawer(
  csrfToken: string,
  form: ServerFormValues,
  options: ServerDrawerOptions,
): Html {
  const openAttr = options.open ? html` open` : html``
  const alert = options.error !== undefined ? html`<p role="alert">${options.error}</p>` : html``
  const isEdit = options.mode === 'edit'
  const title = isEdit ? html`Edit server` : html`Register a server`
  const action = isEdit ? '/servers/edit' : '/servers/add'
  const original = isEdit
    ? html`<input type="hidden" name="original" value="${options.editName ?? ''}" />`
    : html``
  return html`<details class="drawer srv-drawer" id="add-server"${openAttr}>
    <summary class="srv-drawer-sum">Register a server</summary>
    <div class="drawer-bd srv-modal">
      <div class="srv-modal-hd"><span class="pixel upper">${title}</span><a class="icon srv-modal-x" href="${safeUrl('/servers')}" data-close-details="add-server" title="Close">×</a></div>
      ${alert}
      <form method="post" action="${safeUrl(action)}" class="srv-form">
        ${csrfField(csrfToken)}
        ${original}
        ${renderNameField(form, options)}
        <div class="field">
          <span class="label">transport</span>
          ${choices('transport', TRANSPORT_VALUES, form.transport, DEFAULT_TRANSPORT)}
        </div>
        ${renderStdioGroup(form)}
        ${renderHttpGroup(form)}
        <div class="callout">No secrets here. Values may only reference the vault as <code>vault:&lt;name&gt;</code>. The schema rejects secret-looking literals — tokens, keys, long random strings — and the server is not saved.</div>
        <div class="form-actions">
          <a class="btn btn-secondary" href="${safeUrl('/servers')}" data-close-details="add-server">Cancel</a>
          <button type="submit">${isEdit ? html`Save` : html`Register`}</button>
        </div>
      </form>
    </div>
  </details>`
}
