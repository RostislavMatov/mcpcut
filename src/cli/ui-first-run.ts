import { consumeSetupCodeFile, setupCodePathFor, writeSetupCodeFile } from '../admin/setup-code-file.js'
import type { AdminStore } from '../admin/store.js'
import { formatReadableField } from '../journal/format.js'
import { firstRunNotice } from './ui-constants.js'
import type { UiCliIo } from './ui-constants.js'

/**
 * The first-run preparation of `ui` (ADR-0004, amendment of 2026-09-19): what
 * a start does about an install with no admin. It used to mint an `owner`
 * nobody had asked for and leave its token in a file; now it creates NOBODY —
 * it arms the first-run gate and writes the one-time SETUP CODE to a 0600
 * file, and the operator who opens the UI chooses the name on `/setup`.
 *
 * This is the one place that writes a credential-shaped secret to disk.
 * Everything it says goes to stderr, and the code itself goes only into the
 * file: under the service manager stderr IS `run/ui.log`.
 */

/**
 * The two things this module does to the first-run gate, declared here rather
 * than imported: `src/ui/**` has exactly three importers
 * (`tests/architecture/imports.test.ts`) and this is not one of them.
 * `ui/setup-gate.ts`'s `SetupGate` satisfies it structurally.
 */
export interface FirstRunGatePort {
  /** Mints the one-time setup code and returns its plaintext, once. */
  arm(): string
  close(): void
}

/** Where the UI is listening, as the first-run notice names it. */
export interface BoundAddress {
  readonly port: number
  readonly host: string
}

/**
 * Closes the gate when admins exist (removing a code file an earlier,
 * unfinished first run left behind — a shell created the owner instead);
 * otherwise arms it and writes the code. Returns `false` when the store could
 * not be read at all — a plane whose admin file is corrupt must refuse to
 * run, not offer to create an owner beside records it failed to parse — and
 * when the code file could not be written: a first-run page whose code nobody
 * can read is the UI nobody can get into, and the line says what does work.
 */
export async function prepareFirstRun(
  store: Pick<AdminStore, 'listAdmins'>,
  gate: FirstRunGatePort,
  io: UiCliIo,
  address: BoundAddress,
  journalDir: string,
): Promise<boolean> {
  const codePath = setupCodePathFor(journalDir)
  let hasAdmins: boolean
  try {
    hasAdmins = (await store.listAdmins()).length > 0
  } catch (error: unknown) {
    io.stderr.write(`ui: cannot read the admin store: ${readableMessage(error)}\n`)
    return false
  }
  if (hasAdmins) {
    gate.close()
    await removeCodeFile(codePath, io)
    return true
  }
  try {
    await writeSetupCodeFile(codePath, gate.arm())
  } catch (error: unknown) {
    gate.close()
    io.stderr.write(
      `ui: cannot write the setup code file: ${readableMessage(error)} — ` +
        'this install has no admin; create the first one in a shell with ' +
        '"mcpcut admin add <name> --role owner"\n',
    )
    return false
  }
  io.stderr.write(firstRunNotice(address.host, address.port, codePath))
  return true
}

/**
 * Removes the code file; a file that will not unlink is a stderr line, never
 * a refused start or a withheld token — the code in it opens nothing once an
 * admin exists.
 */
export async function removeCodeFile(codePath: string, io: Pick<UiCliIo, 'stderr'>): Promise<void> {
  const outcome = await consumeSetupCodeFile(codePath)
  if (outcome.kind === 'failed') {
    io.stderr.write(`[ui] setup code file: ${formatReadableField(outcome.message)}\n`)
  }
}

/** An error's message made safe for a terminal; a thrown non-Error is stringified. */
function readableMessage(error: unknown): string {
  return formatReadableField(error instanceof Error ? error.message : String(error))
}
