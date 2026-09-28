import { randomInt } from 'node:crypto'
import { createServer } from 'node:net'

/**
 * Ports for a test that hands a port number to code which binds it later —
 * `setup`'s bind check, a service it starts.
 *
 * `listen(0)` then `close()` returns a port from the OS ephemeral range: the
 * range every other worker's `listen(0)` and every outbound connection draw
 * from, so between the close and the later bind another worker can take it
 * (a flake of `tests/cli/setup-cmd.test.ts` on Linux CI, release 0.2.0).
 * Below that range (Linux 32768–60999 by default, macOS and Windows
 * 49152–65535) the OS never hands a port out on its own, and each vitest
 * worker draws from a slice no other worker draws from (`VITEST_POOL_ID` is
 * 1…maxWorkers). A port something else on the machine holds is skipped.
 */

const FIRST_PORT = 10_000
const PORTS_PER_WORKER = 200
/** Where Linux starts handing ports out by default; every slice must end below it. */
const EPHEMERAL_FIRST = 32_768

/**
 * The highest `VITEST_POOL_ID` whose slice still ends below the ephemeral
 * range — 113 with the numbers above. A run with more workers than that is
 * refused rather than handed ports the OS may give to someone else.
 */
export const MAX_POOL_ID = Math.floor((EPHEMERAL_FIRST - FIRST_PORT) / PORTS_PER_WORKER)

export interface PortSlice {
  readonly first: number
  readonly last: number
}

export interface PortAllocator {
  next(): Promise<number>
}

export function portSliceOf(poolId: number): PortSlice {
  const first = FIRST_PORT + (poolId - 1) * PORTS_PER_WORKER
  return { first, last: first + PORTS_PER_WORKER - 1 }
}

/**
 * Hands out each port of `slice` once, beginning `start` ports in and
 * wrapping round; a port something already holds is skipped.
 */
export function createPortAllocator(slice: PortSlice, start: number): PortAllocator {
  const size = slice.last - slice.first + 1
  let handedOut = 0
  return {
    async next(): Promise<number> {
      while (handedOut < size) {
        const port = slice.first + ((start + handedOut) % size)
        handedOut += 1
        if (await isFree(port)) return port
      }
      throw new Error(`reservedPort: every port of the slice ${slice.first}–${slice.last} is taken`)
    },
  }
}

/**
 * One allocator per worker slice. Vitest gives every test file its own module
 * instance, so each file starts afresh; a random start keeps a file from
 * walking the same ports in the same order as the file before it, whose
 * service may still be letting go of one or not have bound it yet.
 */
const allocators = new Map<number, PortAllocator>()

export async function reservedPort(): Promise<number> {
  const poolId = poolIdOf(process.env.VITEST_POOL_ID)
  const allocator = allocators.get(poolId) ?? createPortAllocator(portSliceOf(poolId), randomInt(PORTS_PER_WORKER))
  allocators.set(poolId, allocator)
  return await allocator.next()
}

function poolIdOf(raw: string | undefined): number {
  const id = Number(raw ?? '1')
  if (!Number.isInteger(id) || id < 1 || id > MAX_POOL_ID) {
    throw new Error(`reservedPort: VITEST_POOL_ID=${raw} is outside 1…${MAX_POOL_ID}, where every slice stays below the ephemeral range`)
  }
  return id
}

/** Free on loopback — every caller binds `127.0.0.1`; a test that binds another host checks that host itself. */
function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}
