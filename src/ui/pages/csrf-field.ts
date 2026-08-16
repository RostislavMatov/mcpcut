import { html, type Html } from '../html.js'

/**
 * The hidden CSRF input every POST form in the admin UI carries.
 *
 * It lived as four private copies (`layout`, `servers`, `admins`, `agents`)
 * that had already drifted into two shapes — two took the raw token, two took
 * the whole session, and the emitted tag differed by a self-closing slash. The
 * field name is the part the server actually checks (`CSRF_FIELD_NAME` in
 * `src/ui/server.ts`), so a copy drifting on THAT would fail closed rather than
 * open — but four copies of the one element every state-changing form depends
 * on is four places to get it wrong, and a page that forgets it is a page whose
 * form silently 403s.
 *
 * Takes the token, not the session: a page that only has a token (the login
 * flow's, or a pre-auth render) must be able to call it, and passing the whole
 * session hands a renderer more than it needs.
 */
export function csrfField(csrfToken: string): Html {
  return html`<input type="hidden" name="csrf_token" value="${csrfToken}" />`
}
