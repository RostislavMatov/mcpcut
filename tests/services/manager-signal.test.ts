import { describe, expect, test } from 'vitest'
import { signalProcess, terminateProcess } from '../../src/services/manager-signal.js'

/**
 * The one place a process is asked to go away (review TS-H1): SIGTERM, a
 * bounded wait, then SIGKILL — and, crucially, the promise does not resolve
 * until the process is actually gone. `start` and `stop` both go through this,
 * because the escalation `start` used to do with an unref'd timer was dead
 * code the moment the CLI exited.
 *
 * Injected seams throughout: the escalation is a matter of ORDER and TIMING,
 * and proving it against a real process would need a process that ignores
 * SIGTERM, which `tests/services/manager.test.ts` covers end to end.
 */

const ESCALATION_MS = 60
const POLL_MS = 5

/** A process that dies on the first signal it is sent. */
function politeProcess(): {
  readonly signals: string[]
  readonly isAlive: (pid: number) => boolean
  readonly signal: typeof signalProcess
} {
  const signals: string[] = []
  let alive = true
  return {
    signals,
    isAlive: () => alive,
    signal: (_pid: number, signal: NodeJS.Signals) => {
      signals.push(signal)
      alive = false
      return { kind: 'sent' as const }
    },
  }
}

describe('terminateProcess', () => {
  test('reports a process that went quietly, without escalating', async () => {
    // Arrange
    const target = politeProcess()

    // Act
    const outcome = await terminateProcess(4242, {
      escalationMs: ESCALATION_MS,
      pollMs: POLL_MS,
      isAlive: target.isAlive,
      signal: target.signal,
    })

    // Assert
    expect(outcome).toEqual({ kind: 'gone', forced: false })
    expect(target.signals).toEqual(['SIGTERM'])
  })

  test('escalates to SIGKILL and only resolves once the process is gone', async () => {
    const signals: string[] = []
    let alive = true
    const signal: typeof signalProcess = (_pid, sent) => {
      signals.push(sent)
      // Only SIGKILL is obeyed — the daemon that ignores SIGTERM.
      if (sent === 'SIGKILL') alive = false
      return { kind: 'sent' }
    }

    const outcome = await terminateProcess(4242, {
      escalationMs: ESCALATION_MS,
      pollMs: POLL_MS,
      isAlive: () => alive,
      signal,
    })

    expect(outcome).toEqual({ kind: 'gone', forced: true })
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(alive).toBe(false)
  })

  test('reports the refusal instead of waiting when the pid is already gone', async () => {
    const signal: typeof signalProcess = (pid) => ({
      kind: 'refused',
      detail: `pid ${pid} was already gone`,
    })

    const outcome = await terminateProcess(4242, {
      escalationMs: ESCALATION_MS,
      pollMs: POLL_MS,
      isAlive: () => true,
      signal,
    })

    expect(outcome).toEqual({ kind: 'refused', detail: 'pid 4242 was already gone' })
  })

  test('gives up after the settle window rather than waiting forever on a wedged process', async () => {
    // A process nothing reaches: SIGKILL is uncatchable, so anything still
    // here is in uninterruptible I/O or a zombie nobody reaps.
    const outcome = await terminateProcess(4242, {
      escalationMs: ESCALATION_MS,
      pollMs: POLL_MS,
      settleMs: ESCALATION_MS,
      isAlive: () => true,
      signal: () => ({ kind: 'sent' }),
    })

    expect(outcome).toEqual({ kind: 'gone', forced: true })
  })
})

describe('signalProcess', () => {
  test('turns ESRCH into a refusal rather than a throw', () => {
    const kill = (): never => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    }

    const outcome = signalProcess(4242, 'SIGTERM', kill)

    expect(outcome).toEqual({ kind: 'refused', detail: 'pid 4242 was already gone' })
  })

  test('turns EPERM into a refusal naming the other user', () => {
    const kill = (): never => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    }

    const outcome = signalProcess(1, 'SIGTERM', kill)

    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.detail).toContain('another user')
  })

  test('rethrows an errno it cannot interpret, rather than reporting a lie', () => {
    const kill = (): never => {
      throw Object.assign(new Error('kill EINVAL'), { code: 'EINVAL' })
    }

    expect(() => signalProcess(4242, 'SIGTERM', kill)).toThrow('EINVAL')
  })

  test('reports a delivered signal as sent', () => {
    const seen: Array<[number, string]> = []
    const kill = (pid: number, signal?: number | string): boolean => {
      seen.push([pid, String(signal)])
      return true
    }

    expect(signalProcess(4242, 'SIGTERM', kill)).toEqual({ kind: 'sent' })
    expect(seen).toEqual([[4242, 'SIGTERM']])
  })
})
