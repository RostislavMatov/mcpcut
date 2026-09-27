import { describe, expect, test } from 'vitest'
import { decideIdle, idleDeadlines, REMOVE_AFTER_DAYS, STOP_AFTER_DAYS } from '../../hub/src/idle-sweeper.js'

/**
 * The idle rule (plan `hosted-path-and-ops`, Task C, P5/P6), as a table: an
 * install's activity is the later of its person's last sign-in and its last
 * journal/state write; 60 days without it stops the install, 90 removes it.
 * A stopped install cannot be asked when it was last written, so its stop
 * date stands in: the sweeper stopped it only once 60 days had passed, so its
 * activity was at most `stoppedAt − 60 d` — removal never comes early.
 */

const NOW = '2026-09-27T12:00:00.000Z'
const DAY = 24 * 60 * 60 * 1000

function daysBefore(days: number, from: string = NOW): string {
  return new Date(Date.parse(from) - days * DAY).toISOString()
}

describe('decideIdle', () => {
  test.each([
    // [what, lastSeenAt, lastActivityAt, stoppedAt, expected]
    ['seen today', daysBefore(0), null, null, 'keep'],
    ['seen 59 d 23 h ago, nothing else', daysBefore(59.99), null, null, 'keep'],
    ['seen exactly 60 d ago', daysBefore(60), null, null, 'stop'],
    ['seen 89 d ago', daysBefore(89), null, null, 'stop'],
    ['seen exactly 90 d ago', daysBefore(90), null, null, 'remove'],
    ['seen 400 d ago', daysBefore(400), null, null, 'remove'],
    ['seen 100 d ago, journal written yesterday', daysBefore(100), daysBefore(1), null, 'keep'],
    ['seen 100 d ago, journal written 60 d ago', daysBefore(100), daysBefore(60), null, 'stop'],
    ['seen yesterday, journal written 100 d ago', daysBefore(1), daysBefore(100), null, 'keep'],
    ['seen 70 d ago, journal 95 d ago', daysBefore(70), daysBefore(95), null, 'stop'],
    ['stopped yesterday, seen 200 d ago', daysBefore(200), null, daysBefore(1), 'keep'],
    ['stopped 29 d ago, seen 200 d ago', daysBefore(200), null, daysBefore(29), 'keep'],
    ['stopped exactly 30 d ago, seen 200 d ago', daysBefore(200), null, daysBefore(30), 'remove'],
    ['stopped 40 d ago, seen 10 d ago (never started again)', daysBefore(10), null, daysBefore(40), 'keep'],
    ['stopped 40 d ago, seen 95 d ago', daysBefore(95), null, daysBefore(40), 'remove'],
    ['stopped 20 d ago, seen 65 d ago: already stopped, not yet removed', daysBefore(65), null, daysBefore(20), 'keep'],
    ['activity in the future (a clock ahead)', daysBefore(100), daysBefore(-2), null, 'keep'],
  ] as const)('%s → %s', (_what, lastSeenAt, lastActivityAt, stoppedAt, expected) => {
    expect(decideIdle({ lastSeenAt, lastActivityAt, stoppedAt, now: NOW })).toBe(expected)
  })

  test('a timestamp that is not one never removes anything', () => {
    expect(decideIdle({ lastSeenAt: 'garbage', lastActivityAt: null, stoppedAt: null, now: NOW })).toBe('keep')
    expect(decideIdle({ lastSeenAt: daysBefore(400), lastActivityAt: null, stoppedAt: null, now: 'garbage' })).toBe('keep')
  })

  test('the thresholds are 60 and 90 days', () => {
    expect([STOP_AFTER_DAYS, REMOVE_AFTER_DAYS]).toEqual([60, 90])
  })
})

describe('idleDeadlines', () => {
  test('a running install: 60 and 90 days after the last sign-in', () => {
    expect(idleDeadlines({ lastSeenAt: '2026-09-27T12:00:00.000Z', stoppedAt: null })).toEqual({
      stopsOn: '2026-11-26',
      removedOn: '2026-12-26',
    })
  })

  test('a stopped install: removed 30 days after the stop at the latest', () => {
    expect(idleDeadlines({ lastSeenAt: '2026-01-01T00:00:00.000Z', stoppedAt: '2026-09-01T00:00:00.000Z' }).removedOn).toBe('2026-10-01')
  })
})
