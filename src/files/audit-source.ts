import { JOURNAL_DIR } from '../config.js'
import { formatReadableField } from '../journal/format.js'
import { queryFileAudit, type FileAuditQuery, type FileAuditResult } from './audit.js'
import { queryFileAuditDb } from './db/audit-db.js'
import { ingestJournal, type IngestResult } from './db/ingest.js'
import { openConfiguredDb, type OpenConfiguredOptions } from './db/open-configured.js'

/**
 * Where an audit is answered from (ADR-0020 §5, §6): Postgres when it is
 * turned on, reachable and has caught up with the journal, else the journal
 * walk — with one line saying why and what to do. The audit never fails
 * because of Postgres.
 */

export type AuditSource = 'postgres' | 'journal'

export type AuditAnswer = FileAuditResult & { readonly source: AuditSource; readonly notice?: string }

export interface AuditSourceOptions extends Omit<OpenConfiguredOptions, 'journalDir'> {
  readonly journalDir?: string
  readonly platform?: NodeJS.Platform
  /** How long the ingest may run before the audit answers from the journal. */
  readonly budgetMs: number
  /** @internal test seam: records per ingest batch. */
  readonly batchSize?: number
}

function withNotice(result: FileAuditResult, notice: string): AuditAnswer {
  return { ...result, source: 'journal', notice: formatReadableField(`${notice} — answered from the journal.`) }
}

function behindNotice(ingest: IngestResult, cli: string): string {
  return `Postgres is still catching up with the journal (record ${ingest.lastSeq} of ${ingest.journalMaxSeq}); finish it with \`${cli} files db sync\``
}

export async function fileAudit(query: FileAuditQuery, opts: AuditSourceOptions): Promise<AuditAnswer> {
  const journalDir = opts.journalDir ?? JOURNAL_DIR
  const platform = opts.platform ?? process.platform
  const walk = (): Promise<FileAuditResult> => queryFileAudit(query, { dir: journalDir, platform })
  const configured = await openConfiguredDb({ ...opts, journalDir })
  if (configured.kind === 'off') return { ...(await walk()), source: 'journal' }
  if (configured.kind === 'unavailable') return withNotice(await walk(), configured.reason)
  const { db } = configured
  try {
    const ingest = await ingestJournal(db, { journalDir, platform, budgetMs: opts.budgetMs, ...(opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {}) })
    if (!ingest.caughtUp) return withNotice(await walk(), behindNotice(ingest, opts.cli))
    return { ...(await queryFileAuditDb(db, query, platform)), source: 'postgres' }
  } catch (error: unknown) {
    const reason = formatReadableField(error instanceof Error ? error.message : String(error))
    return withNotice(await walk(), reason)
  } finally {
    await db.close().catch(() => undefined)
  }
}
