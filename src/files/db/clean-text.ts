import { MAX_PATH_LENGTH } from '../constants.js'

/**
 * Postgres refuses U+0000 in text and a lone surrogate in JSON, and an agent
 * controls the paths (and tool names) that are journaled even when refused —
 * up to the proxy's line limit. Every string that goes into the index passes
 * through here first: made valid, and kept to the path limit (anything longer
 * is refused by the server anyway), so one odd record never wedges the ingest
 * or outgrows a batch.
 */
const MAX_INDEXED_CODE_POINTS = MAX_PATH_LENGTH
const CUT_MARK = '…'
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const REPLACEMENT = '�'

function bounded(value: string): string {
  if (value.length <= MAX_INDEXED_CODE_POINTS) return value
  const points = Array.from(value)
  return points.length <= MAX_INDEXED_CODE_POINTS ? value : `${points.slice(0, MAX_INDEXED_CODE_POINTS).join('')}${CUT_MARK}`
}

export function cleanText(value: string): string {
  return bounded(value.replaceAll('\u0000', REPLACEMENT).replace(LONE_SURROGATE, REPLACEMENT))
}

export function cleanOptional(value: string | null): string | null {
  return value === null ? null : cleanText(value)
}
