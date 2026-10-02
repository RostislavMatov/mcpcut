/**
 * Structural helpers shared by the pure policy-document edits
 * (`set-tool-rule.ts`, `set-confirm-in-client.ts`): the raw parsed document is
 * untrusted JSON, so every lookup is an own-property lookup and every "change"
 * is a copy.
 */

export type PlainObject = Record<string, unknown>

export function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isOptionalObject(value: unknown): value is PlainObject | undefined {
  return value === undefined || isPlainObject(value)
}

/** Own-property lookup: a `constructor` server name must never reach the prototype. */
export function ownValue(record: PlainObject, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

export function keyCount(record: PlainObject | undefined): number {
  return record === undefined ? 0 : Object.keys(record).length
}

/** A copy of `record` without `key`, key order preserved; the input is never touched. */
export function omitKey(record: PlainObject, key: string): PlainObject {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))
}
