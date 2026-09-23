/**
 * The session front's concurrency cap as a counter of reservations. Kept in
 * its own file (moved out of `session-support.ts` unchanged) because the one
 * budget it guards is shared with things the front cannot see on its own.
 * Transport-only: nothing semantic is imported here.
 */

/** A reserved concurrency slot; releasing twice is a no-op. */
export interface SessionSlot {
  release(): void
}

export interface SlotCounter {
  /** Takes a slot, or `null` when the cap is already reached. */
  reserve(): SessionSlot | null
  /** Slots held by opens that have not (yet) become registered sessions. */
  reserved(): number
}

/**
 * The concurrency cap, as a synchronous reservation rather than a check.
 * `registered()` counts sessions already in the map; a slot bridges the gap
 * between "this request intends to open a session" and "the session exists"
 * — the window an `await openSession(...)` opens, during which a plain
 * `size >= max` check would let every parallel request through.
 */
export function createSlotCounter(
  max: number,
  registered: () => number,
  reclaim?: () => boolean,
): SlotCounter {
  let held = 0
  const isFull = (): boolean => registered() + held >= max
  return Object.freeze({
    reserve(): SessionSlot | null {
      // `reclaim` is asked only when the budget is full, and once: a `true`
      // means one slot of the shared budget was freed synchronously, so the
      // second look can see it.
      if (isFull() && !(reclaim?.() === true && !isFull())) {
        return null
      }
      held += 1
      let isReleased = false
      return {
        release(): void {
          if (isReleased) return
          isReleased = true
          held -= 1
        },
      }
    },
    reserved: () => held,
  })
}
