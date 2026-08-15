/**
 * Column narrowing for the journal's SQL read arm. `node:sqlite` hands a row
 * back as `unknown`-valued columns, and both halves of the arm (`db-read.ts`
 * for paging and cross-session walks, `db-read-session.ts` for one session)
 * have to turn those into the shapes a reader can use. The narrowings live
 * here so the two cannot disagree about what an absent or oddly-typed column
 * means — a `NULL` aggregate over no rows is the common case, and it must
 * read as "empty", never crash a page.
 *
 * Nothing here knows any SQL: it is the column-to-value edge alone.
 */

/** A TEXT column's value; anything else (an aggregate over no rows) reads as absent. */
export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** An INTEGER column's value, tolerating the bigint form and a null aggregate. */
export function numberOf(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

/** Epoch milliseconds of an ISO timestamp; an unparseable one reads as the epoch. */
export function epochMsOf(ts: string): number {
  const parsed = Date.parse(ts)
  return Number.isNaN(parsed) ? 0 : parsed
}
