import { html, type Html } from '../../../src/ui/html.js'

/**
 * The hidden CSRF input every POST form on the hub carries — the hub's own
 * copy of `src/ui/pages/csrf-field.ts`, not an import of it: the hub borrows
 * only the dependency-free primitives on the H1 allowlist
 * (`tests/architecture/hub-imports.test.ts`), and the console's `pages/`
 * directory is not on it. The field name (`csrf_token`) is the one the hub's
 * server checks on every state-changing route, mirroring the console's
 * `CSRF_FIELD_NAME`.
 */
export function csrfField(csrfToken: string): Html {
  return html`<input type="hidden" name="csrf_token" value="${csrfToken}" />`
}
