import { describe, expect, test } from 'vitest'
import { asProvisionerError, ProvisionerError } from '../../../hub/src/provisioner/errors.js'
import { createKeyedLock } from '../../../hub/src/provisioner/keyed-lock.js'
import { isReadyStatus, ownerTokenFrom, READY_TIMEOUT_MS, waitUntilReady } from '../../../hub/src/provisioner/tenant-exec.js'
import { execKindOf, useProvisioner } from './provisioner-harness.js'

/**
 * The pieces under `service.ts` (plan `tenant-orchestrator`, Task 4): the
 * readiness check and its deadline, the owner-token line parser, the
 * per-subdomain lock and the error mapping.
 */

const ctx = useProvisioner()

describe('isReadyStatus', () => {
  test.each([
    ['both external', '[{"service":"ui","state":"external"},{"service":"serve","state":"external"}]', true],
    ['both running', '[{"service":"serve","state":"running"},{"service":"ui","state":"running"}]', true],
    ['one stopped', '[{"service":"ui","state":"running"},{"service":"serve","state":"stopped"}]', false],
    ['one missing', '[{"service":"ui","state":"running"}]', false],
    ['starting', '[{"service":"ui","state":"starting"},{"service":"serve","state":"running"}]', false],
    ['not JSON', 'ui running', false],
    ['an object', '{"service":"ui","state":"running"}', false],
  ])('%s → %s', (_label, stdout, ready) => {
    expect(isReadyStatus(stdout)).toBe(ready)
  })
})

describe('waitUntilReady', () => {
  test('gives up at the deadline measured by the injected clock, 45 s by default', async () => {
    expect(READY_TIMEOUT_MS).toBe(45_000)
    const { id } = await ctx.docker().createContainer('mcpcut-t-alice', { Image: 'x', Labels: { 'mcpcut.tenant': 'alice' } })
    await ctx.docker().startContainer(id)
    ctx.answer((argv) => (execKindOf(argv) === 'status' ? { exitCode: 0, stdout: '[]' } : undefined))
    let now = 0
    const sleeps: number[] = []

    const failure = waitUntilReady(ctx.docker(), 'mcpcut-t-alice', {
      clock: () => now,
      sleep: async (ms) => {
        sleeps.push(ms)
        now += ms
      },
    })

    await expect(failure).rejects.toMatchObject({ code: 'not-ready', message: 'the install did not come up within 45 s' })
    expect(sleeps.every((ms) => ms === 1000)).toBe(true)
    expect(sleeps.length).toBe(44)
  })

  test('an exec that fails (the container is not running) is "not yet", not a failure', async () => {
    await ctx.docker().createContainer('mcpcut-t-alice', { Image: 'x' })
    let now = 0

    const failure = waitUntilReady(ctx.docker(), 'mcpcut-t-alice', {
      timeoutMs: 30,
      pollMs: 10,
      clock: () => now,
      sleep: async (ms) => {
        now += ms
      },
    })

    await expect(failure).rejects.toMatchObject({ code: 'not-ready' })
  })
})

describe('ownerTokenFrom', () => {
  test('takes the token from the one JSON line, surrounding whitespace allowed', () => {
    const line = '{"admin":"alice","role":"owner","token":"mcpa_abcdefghijklmnopqrstuvwx"}\n'

    expect(ownerTokenFrom(line, 'alice', 'admin add')).toBe('mcpa_abcdefghijklmnopqrstuvwx')
  })
})

describe('createKeyedLock', () => {
  test('runs one task per key at a time and forgets a key once idle', async () => {
    const lock = createKeyedLock()
    const order: string[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))

    const first = lock.run('a', async () => {
      order.push('a1 start')
      await gate
      order.push('a1 end')
    })
    const second = lock.run('a', async () => {
      order.push('a2')
    })
    const other = lock.run('b', async () => {
      order.push('b')
    })
    await other
    expect(order).toEqual(['a1 start', 'b'])
    release()
    await Promise.all([first, second])

    expect(order).toEqual(['a1 start', 'b', 'a1 end', 'a2'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lock.size()).toBe(0)
  })

  test('a failed task releases the key for the next', async () => {
    const lock = createKeyedLock()

    await expect(lock.run('a', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(lock.run('a', async () => 'next')).resolves.toBe('next')
  })
})

describe('asProvisionerError', () => {
  test('passes a ProvisionerError through, hides anything else', () => {
    const own = new ProvisionerError('exists', 'x')

    expect(asProvisionerError(own, 'op')).toBe(own)
    const hidden = asProvisionerError(new Error('mcpa_secretsecretsecret'), 'create alice')
    expect(hidden).toMatchObject({ code: 'internal', message: 'create alice: failed unexpectedly' })
  })
})
