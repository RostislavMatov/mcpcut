/**
 * One-at-a-time per key (plan `tenant-orchestrator`, Task 4): two creates of
 * the same subdomain must not both find it free and race to build it, and a
 * remove must not tear down a tenant a create is still building. Calls for
 * different keys run concurrently. A failed call releases the key like a
 * successful one.
 */

export interface KeyedLock {
  run<T>(key: string, task: () => Promise<T>): Promise<T>
  /** Keys with a task running or queued — for tests. */
  size(): number
}

export function createKeyedLock(): KeyedLock {
  const tails = new Map<string, Promise<void>>()
  return {
    run: <T>(key: string, task: () => Promise<T>): Promise<T> => {
      const previous = tails.get(key) ?? Promise.resolve()
      const result = previous.then(task)
      const tail = result.then(
        () => undefined,
        () => undefined,
      )
      tails.set(key, tail)
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key)
      })
      return result
    },
    size: () => tails.size,
  }
}
