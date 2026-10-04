import type { AccessEditInfo } from '../../journal/record.js'
import type { UiSession } from '../auth.js'
import type { AccessEditJournalOutcome, AccessEditJournalPort } from './agents.js'

/**
 * Records one access change in the journal and says whether the record
 * landed. The write has already happened when this runs, so a journal that
 * cannot be reached must not turn it into a 500: the injected writer never
 * throws by contract (`groups/journal-access-edit.ts` returns a drop
 * indicator instead), and this guard keeps that true for ANY injected port —
 * a port that threw has not written either, so it answers as a drop. No port
 * at all is the composition root's choice (a plane assembled without a
 * journal), not a record that was lost, and earns no warning.
 */
export async function journalAccessEditGuarded(
  write: AccessEditJournalPort | undefined,
  session: UiSession,
  info: Omit<AccessEditInfo, 'actor'>,
): Promise<AccessEditJournalOutcome> {
  if (write === undefined) return { written: true }
  try {
    const { written } = await write({
      actor: { adminName: session.adminName, role: session.role, via: 'ui' },
      ...info,
    })
    return { written }
  } catch {
    // Contained, not swallowed: the audit sink already recorded the attributed
    // edit, the writer's own diagnostics report the fault, and the verdict
    // goes onto the admin's success page.
    return { written: false }
  }
}
