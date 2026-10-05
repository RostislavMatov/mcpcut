/**
 * Postgres refuses U+0000 in text and a lone surrogate in JSON, and an agent
 * controls the paths that are journaled even when refused. Every string that
 * goes into the index passes through here first, so one odd record never
 * wedges the ingest.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const REPLACEMENT = '�'

export function cleanText(value: string): string {
  return value.replaceAll('\u0000', REPLACEMENT).replace(LONE_SURROGATE, REPLACEMENT)
}

export function cleanOptional(value: string | null): string | null {
  return value === null ? null : cleanText(value)
}
