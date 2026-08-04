/**
 * A minimal worker-pool `map`: runs `fn` over `items` with at most
 * `concurrency` calls in flight at once, preserving input order in the
 * result. Used to bound how many journal files are open at the same time
 * (EMFILE risk) without pulling in a dependency for something this small.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      const item = items[currentIndex] as T
      results[currentIndex] = await fn(item)
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))
  return results
}
