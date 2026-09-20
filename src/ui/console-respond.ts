import type { ServerResponse } from 'node:http'
import type { ConsoleError } from '../console-api/contract.js'
import { CONTENT_TYPE_JSON } from './constants.js'
import { securityHeaders } from './security-headers.js'

/**
 * The one way the console API writes a JSON answer (ADR-0014): `no-store`
 * (there is no session to cache around, but a token or a run's output must
 * never sit in any cache either), the same security headers every other UI
 * response carries, and a body that is always `consoleErrorSchema`-shaped on
 * anything but success.
 */

const NO_STORE = 'no-store'

/** Writes one buffered JSON document and ends the response. */
export function writeConsoleJson(
  res: ServerResponse,
  status: number,
  doc: unknown,
  behindTls: boolean,
): void {
  const body = Buffer.from(JSON.stringify(doc), 'utf8')
  res.writeHead(status, {
    'content-type': CONTENT_TYPE_JSON,
    'cache-control': NO_STORE,
    ...securityHeaders({ behindTls }),
  })
  res.end(body)
}

/** Writes one `consoleErrorSchema` refusal. `message` is already safe to show — never a raw error detail. */
export function writeConsoleError(
  res: ServerResponse,
  status: number,
  error: ConsoleError['error'],
  message: string,
  behindTls: boolean,
): void {
  const doc: ConsoleError = { error, message }
  writeConsoleJson(res, status, doc, behindTls)
}
