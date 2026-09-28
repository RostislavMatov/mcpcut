import { existsSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createPortAllocator, MAX_POOL_ID, portSliceOf, reservedPort, type PortSlice } from './ports.js'

/** The lowest port Linux hands out on its own by default; macOS and Windows start at 49152. */
const LINUX_EPHEMERAL_FIRST = 32_768

/** Where Linux keeps the range it hands ports out from — the CI runner's own answer. */
const PROC_PORT_RANGE = '/proc/sys/net/ipv4/ip_local_port_range'

/**
 * Ports above the last worker slice and below the ephemeral range: no worker
 * draws from them and the OS does not hand them out, so an allocator test
 * here knows exactly which ports are free.
 */
const SPARE: PortSlice = { first: 32_700, last: 32_709 }
const SPARE_PAIR: PortSlice = { first: 32_710, last: 32_711 }

async function listenOn(port: number): Promise<Server> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()))
  return server
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('reservedPort — a port no other worker can take', () => {
  test('lies below the range the OS hands out on its own', async () => {
    const port = await reservedPort()

    expect(port).toBeGreaterThan(1024)
    expect(port).toBeLessThan(LINUX_EPHEMERAL_FIRST)
  })

  test('never hands out the same port twice', async () => {
    const ports = [await reservedPort(), await reservedPort(), await reservedPort()]

    expect(new Set(ports).size).toBe(ports.length)
  })

  test("comes from this worker's own slice", async () => {
    vi.stubEnv('VITEST_POOL_ID', '3')
    const { first, last } = portSliceOf(3)

    const port = await reservedPort()

    expect(port).toBeGreaterThanOrEqual(first)
    expect(port).toBeLessThanOrEqual(last)
  })

  test('refuses a worker id whose slice would reach the ephemeral range', async () => {
    vi.stubEnv('VITEST_POOL_ID', String(MAX_POOL_ID + 1))

    await expect(reservedPort()).rejects.toThrow(/VITEST_POOL_ID/)
  })
})

describe('createPortAllocator — each port of a slice once', () => {
  test('skips a port something else already holds', async () => {
    const allocator = createPortAllocator(SPARE, 0)
    const holder = await listenOn(SPARE.first + 1)
    try {
      expect(await allocator.next()).toBe(SPARE.first)
      expect(await allocator.next()).toBe(SPARE.first + 2)
    } finally {
      await close(holder)
    }
  })

  test('begins at its start and wraps round to the bottom of the slice', async () => {
    const allocator = createPortAllocator(SPARE, SPARE.last - SPARE.first)

    expect(await allocator.next()).toBe(SPARE.last)
    expect(await allocator.next()).toBe(SPARE.first)
  })

  test('refuses once every port of the slice is spent', async () => {
    const allocator = createPortAllocator(SPARE_PAIR, 0)
    await allocator.next()
    await allocator.next()

    await expect(allocator.next()).rejects.toThrow(/taken/)
  })
})

describe('portSliceOf — one slice per worker', () => {
  test('slices of neighbouring workers do not overlap', () => {
    for (let id = 1; id < MAX_POOL_ID; id += 1) {
      expect(portSliceOf(id).last).toBeLessThan(portSliceOf(id + 1).first)
    }
  })

  test('the last slice ends below the spare ports and the ephemeral range', () => {
    expect(portSliceOf(MAX_POOL_ID).last).toBeLessThan(SPARE.first)
    expect(SPARE_PAIR.last).toBeLessThan(LINUX_EPHEMERAL_FIRST)
  })

  test.runIf(existsSync(PROC_PORT_RANGE))("every slice sits below this machine's ephemeral range", () => {
    const [firstEphemeral] = readFileSync(PROC_PORT_RANGE, 'utf8').trim().split(/\s+/).map(Number)

    expect(SPARE_PAIR.last).toBeLessThan(firstEphemeral ?? 0)
  })
})
