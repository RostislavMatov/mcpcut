import { renderLoginPage } from '../pages/login.js'
import type { UiHandler, UiResult } from '../routes.js'

/**
 * `GET /login` handler (M4 Task 13): serves the public token-entry page. The
 * matching POST is handled by the server core (`@login`), so this factory only
 * renders the form. No dependencies — the page is static — but kept a factory
 * for symmetry with the other handler modules and future injectables.
 */

const HTTP_STATUS_OK = 200

/** Builds the injectable `loginPage` handler. */
export function createLoginPage(): UiHandler {
  return function loginPage(): UiResult {
    return { kind: 'response', status: HTTP_STATUS_OK, body: renderLoginPage() }
  }
}
