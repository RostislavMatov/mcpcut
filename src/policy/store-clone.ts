/**
 * Deep copy that PRESERVES prototypes, for the values `JsonStore.read()` hands
 * out.
 *
 * `structuredClone` does not: it rebuilds every plain object with
 * `Object.prototype`, so a null-prototype map — the shape
 * `policy/inventory-store.ts` deliberately builds for every tool/server map,
 * because a tool may be named `__proto__`, `constructor` or `toString` — comes
 * back out of the clone as an ordinary object. Read-side bracket lookups keyed
 * by those untrusted names (`quarantine show`, `Inventory.serverEntryOf`, the
 * UI quarantine card) would then resolve through the prototype chain again and
 * see a function where the store holds nothing.
 *
 * So the copy handed to a caller must have the SAME prototype shape the
 * validator produced. Only the JSON-document shapes the stores actually carry
 * are handled structurally — primitives, arrays, and plain objects with either
 * `Object.prototype` or no prototype at all; anything else (a `Date`, a `Map`,
 * a class instance a future validator might return) falls back to
 * `structuredClone`, which is what this module replaced for those values
 * anyway.
 *
 * Keys are written with `Object.defineProperty`, never `next[key] = value`: on
 * an `Object.prototype`-backed target, assigning the own key `__proto__` that
 * `JSON.parse` happily produces would set the prototype instead of storing the
 * value.
 */

/** A deep copy of `value` whose objects keep the prototypes the source had. */
export function cloneKeepingPrototypes<T>(value: T): T {
  return cloneUnknown(value) as T
}

function cloneUnknown(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(cloneUnknown)

  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== null && proto !== Object.prototype) return structuredClone(value)

  const next = Object.create(proto as object | null) as Record<string, unknown>
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(next, key, {
      value: cloneUnknown(entry),
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
  return next
}
