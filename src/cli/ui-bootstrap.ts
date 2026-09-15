import { bootstrapTokenPathFor, writeBootstrapTokenFile } from '../admin/bootstrap-file.js'
import type { AdminStore, CreatedAdmin } from '../admin/store.js'
import { formatReadableField } from '../journal/format.js'
import { BOOTSTRAP_ADMIN_NAME, bootstrapNotice } from './ui-constants.js'
import type { UiCliIo } from './ui-constants.js'

/**
 * The first-owner bootstrap of `ui` (phase 6 split from `ui-cmd.ts` for the
 * file budget): the one place that mints an admin without an admin asking,
 * and the one place that writes a credential to disk. Everything it says goes
 * to stderr, and the token itself goes only into the bootstrap file.
 */

/** Where the UI is listening, as the bootstrap notice names it. */
export interface BoundAddress {
  readonly port: number
  readonly host: string
}

/**
 * Mints the first `owner` when the store holds no active admin and writes its
 * one-time token to the bootstrap file; stderr gets the path, never the token.
 * Returns `false` when the store could not be read at all — a plane whose
 * admin file is corrupt must refuse to run, not silently bootstrap a second
 * owner beside records it failed to parse — and when the token file could not
 * be written: the owner exists by then, so the line says how to get a token
 * for it (`admin rotate`), and the run stops rather than serve a UI whose
 * only admin has a credential nobody can read.
 */
export async function bootstrapAdmin(
  store: AdminStore,
  io: UiCliIo,
  address: BoundAddress,
  journalDir: string,
): Promise<boolean> {
  let minted: CreatedAdmin
  try {
    if ((await store.listAdmins()).length > 0) return true
    minted = await store.createAdmin(BOOTSTRAP_ADMIN_NAME, 'owner')
  } catch (error: unknown) {
    io.stderr.write(`ui: cannot read the admin store: ${readableMessage(error)}\n`)
    return false
  }
  const tokenPath = bootstrapTokenPathFor(journalDir)
  try {
    await writeBootstrapTokenFile(tokenPath, minted.token)
  } catch (error: unknown) {
    io.stderr.write(
      `ui: cannot write the bootstrap token file: ${readableMessage(error)} — ` +
        `the "${minted.admin.name}" admin exists; run "mcp-journal admin rotate ${minted.admin.name}" ` +
        'for a new token\n',
    )
    return false
  }
  io.stderr.write(bootstrapNotice(address.host, address.port, minted.admin.name, tokenPath))
  return true
}

/** An error's message made safe for a terminal; a thrown non-Error is stringified. */
function readableMessage(error: unknown): string {
  return formatReadableField(error instanceof Error ? error.message : String(error))
}
