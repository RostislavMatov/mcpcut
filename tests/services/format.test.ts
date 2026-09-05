import { describe, expect, test } from 'vitest'
import { formatStartResult, formatStatusTable, formatStopResult, statusJson } from '../../src/services/format.js'
import type { ServiceStatus, StartResult, StopResult } from '../../src/services/manager.js'

/**
 * How `mcpcut status|start|stop` reads (mcpcut phase 1, Task 11). Pure string
 * assertions on purpose: these lines are the operator's whole view of a
 * detached process, and "it still lines up" is a property that only an exact
 * expectation defends.
 */

const RUNNING_UI: ServiceStatus = {
  service: 'ui',
  state: 'running',
  host: '127.0.0.1',
  port: 8091,
  pid: 4242,
  startedAt: '2026-09-04T09:12:03.000Z',
  logPath: '/var/lib/mcpcut/run/ui.log',
}

const STOPPED_SERVE: ServiceStatus = {
  service: 'serve',
  state: 'stopped',
  host: '127.0.0.1',
  port: 8090,
  logPath: '/var/lib/mcpcut/run/serve.log',
}

describe('formatStatusTable', () => {
  test('renders one aligned row per service, as the plan shows it', () => {
    const table = formatStatusTable([
      RUNNING_UI,
      { ...RUNNING_UI, service: 'serve', port: 8090, pid: 4243, logPath: '/var/lib/mcpcut/run/serve.log' },
    ])

    expect(table).toBe(
      'ui     running  pid 4242  127.0.0.1:8091  since 2026-09-04T09:12:03Z\n' +
        'serve  running  pid 4243  127.0.0.1:8090  since 2026-09-04T09:12:03Z\n',
    )
  })

  test('shows an em dash where a stopped service has no pid and no start time', () => {
    const table = formatStatusTable([RUNNING_UI, STOPPED_SERVE])

    expect(table).toBe(
      'ui     running  pid 4242  127.0.0.1:8091  since 2026-09-04T09:12:03Z\n' +
        'serve  stopped  —         127.0.0.1:8090  —\n',
    )
  })

  test('prints a detail on its own indented line beneath the row it belongs to', () => {
    const table = formatStatusTable([{ ...STOPPED_SERVE, state: 'stale', detail: 'pid 4242 is alive but not answering' }])

    expect(table).toBe(
      'serve  stale  —  127.0.0.1:8090  —\n  pid 4242 is alive but not answering\n',
    )
  })

  test('renders no lines at all for no services', () => {
    expect(formatStatusTable([])).toBe('')
  })
})

describe('statusJson', () => {
  test('sorts the keys of every object so two runs of --json diff cleanly', () => {
    const json = statusJson([RUNNING_UI])

    expect(json).toBe(
      '[{"host":"127.0.0.1","logPath":"/var/lib/mcpcut/run/ui.log","pid":4242,"port":8091,' +
        '"service":"ui","startedAt":"2026-09-04T09:12:03.000Z","state":"running"}]\n',
    )
  })

  test('omits the fields a stopped service does not have rather than nulling them', () => {
    const parsed: unknown = JSON.parse(statusJson([STOPPED_SERVE]))

    expect(parsed).toEqual([
      {
        host: '127.0.0.1',
        logPath: '/var/lib/mcpcut/run/serve.log',
        port: 8090,
        service: 'serve',
        state: 'stopped',
      },
    ])
  })
})

describe('formatStartResult', () => {
  test('names the pid, the address and the log of a service it just started', () => {
    const result: StartResult = { kind: 'started', status: RUNNING_UI }

    expect(formatStartResult('ui', result)).toBe(
      'ui:    started pid 4242 on http://127.0.0.1:8091 (log /var/lib/mcpcut/run/ui.log)\n',
    )
  })

  test('reports an already running service without pretending it started one', () => {
    const result: StartResult = { kind: 'already-running', status: RUNNING_UI }

    expect(formatStartResult('ui', result)).toBe('ui:    already running pid 4242 on http://127.0.0.1:8091\n')
  })

  test('says who answers when something outside mcpcut holds the port', () => {
    const result: StartResult = {
      kind: 'external',
      status: { ...STOPPED_SERVE, state: 'external' },
    }

    expect(formatStartResult('serve', result)).toBe(
      'serve: external — something answers on 127.0.0.1:8090; mcpcut did not start it\n',
    )
  })

  test('says the install is supervised elsewhere when nothing answers yet', () => {
    const result: StartResult = { kind: 'external', status: STOPPED_SERVE }

    expect(formatStartResult('serve', result)).toBe(
      'serve: external — this install hands its services to another supervisor\n',
    )
  })

  test('follows a failed start with the log tail, so the reason is on screen', () => {
    const result: StartResult = {
      kind: 'failed',
      reason: 'exited with code 3',
      logTail: ['ui: refusing to start (FAKE_EXIT_CODE=3)', 'ui: bye'],
    }

    expect(formatStartResult('ui', result)).toBe(
      'ui:    failed to start: exited with code 3\n' +
        '  log: ui: refusing to start (FAKE_EXIT_CODE=3)\n' +
        '  log: ui: bye\n',
    )
  })

  test('prints only the reason when a failed start left no log behind', () => {
    const result: StartResult = { kind: 'failed', reason: 'did not answer within 15000 ms', logTail: [] }

    expect(formatStartResult('ui', result)).toBe('ui:    failed to start: did not answer within 15000 ms\n')
  })

  test('passes an unsupported platform through with its reason', () => {
    const result: StartResult = { kind: 'unsupported', reason: 'no detached services on Windows' }

    expect(formatStartResult('ui', result)).toBe('ui:    unsupported: no detached services on Windows\n')
  })
})

describe('formatStopResult', () => {
  test('names the pid it stopped', () => {
    const result: StopResult = { kind: 'stopped', pid: 4242, forced: false }

    expect(formatStopResult('ui', result)).toBe('ui:    stopped pid 4242\n')
  })

  test('admits when the stop had to escalate to SIGKILL', () => {
    const result: StopResult = { kind: 'stopped', pid: 4242, forced: true }

    expect(formatStopResult('ui', result)).toBe('ui:    stopped pid 4242 (forced: SIGKILL after SIGTERM)\n')
  })

  test('says nothing was running rather than claiming a stop', () => {
    expect(formatStopResult('serve', { kind: 'not-running' })).toBe('serve: not running\n')
  })

  test('reports a cleared stale pid file with its pid and detail', () => {
    const result: StopResult = { kind: 'stale-cleared', pid: 4242, detail: 'pid 4242 belongs to another user' }

    expect(formatStopResult('ui', result)).toBe(
      'ui:    stale pid file cleared (pid 4242) — pid 4242 belongs to another user\n',
    )
  })

  test('reports a cleared corrupt pid file, which has no pid to name', () => {
    expect(formatStopResult('ui', { kind: 'stale-cleared' })).toBe('ui:    stale pid file cleared\n')
  })

  test('refuses to claim a stop of a service mcpcut does not manage', () => {
    expect(formatStopResult('serve', { kind: 'external' })).toBe('serve: external — not managed by mcpcut\n')
  })

  test('passes an unsupported platform through with its reason', () => {
    expect(formatStopResult('ui', { kind: 'unsupported', reason: 'no detached services on Windows' })).toBe(
      'ui:    unsupported: no detached services on Windows\n',
    )
  })
})

describe('untrusted text never reaches the terminal raw', () => {
  /**
   * A pid file, a daemon log and a host read back from one are all things an
   * attacker (or a merely broken program) can put bytes into, and all three
   * are printed by these views. A raw CSI sequence there clears the line the
   * operator was reading -- the same terminal-injection class
   * `journal/format.ts` exists for, so it is the same sanitizer here.
   */
  const ESCAPE_SEQUENCE = '\x1b[2K'

  test('escapes control characters in a status detail', () => {
    const table = formatStatusTable([
      { ...STOPPED_SERVE, state: 'stale', detail: `pid 4242 gone${ESCAPE_SEQUENCE}cleared` },
    ])

    expect(table).not.toContain('\x1b')
    expect(table).toContain('pid 4242 gone?[2Kcleared')
  })

  test('escapes control characters in the log tail of a failed start', () => {
    const result: StartResult = {
      kind: 'failed',
      reason: `exited with code 1${ESCAPE_SEQUENCE}`,
      logTail: [`ui: cannot bind${ESCAPE_SEQUENCE}127.0.0.1:8091`],
    }

    const text = formatStartResult('ui', result)

    expect(text).not.toContain('\x1b')
    expect(text).toContain('  log: ui: cannot bind?[2K127.0.0.1:8091\n')
    expect(text).toContain('failed to start: exited with code 1?[2K')
  })

  test('escapes control characters in a host read back from a pid file', () => {
    const table = formatStatusTable([{ ...STOPPED_SERVE, host: `127.0.0.1${ESCAPE_SEQUENCE}` }])

    expect(table).not.toContain('\x1b')
  })
})

describe('a bracketed IPv6 host is rendered as one authority, not two', () => {
  test('does not double-bracket an address the config already bracketed', () => {
    const table = formatStatusTable([{ ...STOPPED_SERVE, host: '[::1]' }])

    expect(table).toContain('[::1]:8090')
    expect(table).not.toContain('[[::1]]')
  })

  test('brackets a bare IPv6 address in the started line', () => {
    const result: StartResult = { kind: 'started', status: { ...RUNNING_UI, host: '::1' } }

    expect(formatStartResult('ui', result)).toContain('http://[::1]:8091')
  })
})
