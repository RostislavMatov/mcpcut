import { describe, expect, test } from 'vitest'
import { statusJson } from '../../src/services/format.js'
import type { ServiceStatus } from '../../src/services/manager-types.js'
import { EXTERNAL_GLYPH } from '../../src/tui/constants-live.js'
import {
  hasDownService,
  isServiceDown,
  NO_SERVICES_TEXT,
  parseServicesJson,
  servicesHeaderPart,
} from '../../src/tui/services-summary.js'

/**
 * The services part of the console header (mcpcut phase 2, task 8).
 *
 * Every parse case is fed the REAL `statusJson` the `services status --json`
 * command prints, not a hand-written literal: the console reads that output
 * back through a seam it does not own, so a test written against an invented
 * document would keep passing after the command's shape changed.
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

describe('parseServicesJson', () => {
  test('reads back the document `status --json` prints', () => {
    const parsed = parseServicesJson(statusJson([RUNNING_UI, STOPPED_SERVE]))

    expect(parsed).toEqual([
      { service: 'ui', state: 'running', host: '127.0.0.1', port: 8091 },
      { service: 'serve', state: 'stopped', host: '127.0.0.1', port: 8090 },
    ])
  })

  test('tolerates the fields it does not read, rather than rejecting the document', () => {
    // `logPath` and `pid` are in every real status; a strict schema would make
    // the header go blank the day the command gains a field.
    const parsed = parseServicesJson(statusJson([RUNNING_UI]))

    expect(parsed).toHaveLength(1)
    expect(parsed?.[0]).not.toHaveProperty('logPath')
  })

  test('parses an empty status list as an empty list, not as a failure', () => {
    expect(parseServicesJson(statusJson([]))).toEqual([])
  })

  test('returns undefined for text that is not JSON', () => {
    expect(parseServicesJson('services: could not be read\n')).toBeUndefined()
  })

  test('returns undefined for a JSON document that is not an array', () => {
    expect(parseServicesJson('{"service":"ui"}')).toBeUndefined()
  })

  test('returns undefined when a port arrives as a string', () => {
    expect(
      parseServicesJson('[{"service":"ui","state":"running","host":"127.0.0.1","port":"8091"}]'),
    ).toBeUndefined()
  })

  test('returns undefined when a read field is missing', () => {
    expect(parseServicesJson('[{"service":"ui","state":"running","port":8091}]')).toBeUndefined()
  })
})

describe('servicesHeaderPart', () => {
  test('writes one glyph and one authority per service, as the plan shows it', () => {
    const parsed = parseServicesJson(statusJson([RUNNING_UI, STOPPED_SERVE]))

    expect(servicesHeaderPart(parsed)).toBe('ui ● 127.0.0.1:8091 · serve ○ 127.0.0.1:8090')
  })

  test('gives `starting` its own glyph, and every other state the stopped one', () => {
    const parsed = parseServicesJson(
      statusJson([
        { ...RUNNING_UI, state: 'starting' },
        { ...STOPPED_SERVE, state: 'stale' },
      ]),
    )

    expect(servicesHeaderPart(parsed)).toBe('ui ◐ 127.0.0.1:8091 · serve ○ 127.0.0.1:8090')
  })

  test('external gets its own glyph: answering, but not ours to start or stop', () => {
    // Phase 5 (Q16): under compose or systemd every service is `external`, and
    // drawing it as `○` told an operator to start something already serving.
    const parsed = parseServicesJson(statusJson([{ ...STOPPED_SERVE, state: 'external' }]))

    expect(servicesHeaderPart(parsed)).toBe(`serve ${EXTERNAL_GLYPH} 127.0.0.1:8090`)
    expect(EXTERNAL_GLYPH).toBe('◉')
  })

  test('brackets a bare IPv6 bind exactly once', () => {
    const parsed = parseServicesJson(statusJson([{ ...RUNNING_UI, host: '::1' }]))

    expect(servicesHeaderPart(parsed)).toBe('ui ● [::1]:8091')
  })

  test('escape sequences and invisible characters never leave this function', () => {
    // The document is bytes from a command, and `z.string()` says nothing
    // about a charset. The header centres and pads this text (`render-signin`
    // measures it before `padRight` sanitises), so a host carrying an erase
    // sequence would both mis-measure the block and be one layer away from the
    // terminal (F9).
    const parsed = parseServicesJson(
      statusJson([{ ...RUNNING_UI, host: '127.0.0.1\x1b[2K\u200b' }]),
    )

    const part = servicesHeaderPart(parsed)

    expect(part).not.toContain('\x1b')
    expect(part).not.toContain('\u200b')
    expect(part).toBe('ui ● 127.0.0.1:8091')
  })

  test('says the services are unknown when the status could not be read', () => {
    expect(servicesHeaderPart(undefined)).toBe(NO_SERVICES_TEXT)
    expect(NO_SERVICES_TEXT).toBe('services: —')
  })

  test('says the same for an install that reported no services at all', () => {
    // An empty join would leave the header with a dangling separator.
    expect(servicesHeaderPart([])).toBe(NO_SERVICES_TEXT)
  })
})

describe('isServiceDown', () => {
  test('counts the two states an operator can fix with `start`', () => {
    expect(isServiceDown('stopped')).toBe(true)
    expect(isServiceDown('stale')).toBe(true)
  })

  test('leaves the states nothing needs doing about alone', () => {
    // `external` is answering — it is down for nobody, and mcpcut could not
    // start it anyway (its supervisor owns it).
    expect(isServiceDown('running')).toBe(false)
    expect(isServiceDown('starting')).toBe(false)
    expect(isServiceDown('external')).toBe(false)
  })

  test('says nothing is down about a state it does not know', () => {
    // The state arrives as bytes from a command: an unknown word must not turn
    // the sign-in banner into a hint about a service nobody can name.
    expect(isServiceDown('who-knows')).toBe(false)
  })
})

describe('hasDownService', () => {
  test('is true when any service in the list is down', () => {
    const parsed = parseServicesJson(statusJson([RUNNING_UI, STOPPED_SERVE]))

    expect(hasDownService(parsed)).toBe(true)
  })

  test('is false when every service is up or answers elsewhere', () => {
    const parsed = parseServicesJson(
      statusJson([RUNNING_UI, { ...STOPPED_SERVE, state: 'external' }]),
    )

    expect(hasDownService(parsed)).toBe(false)
  })

  test('is false for a status that could not be read, and for one naming nothing', () => {
    // An unreadable status is not evidence a service is down; the banner stays
    // silent rather than guessing.
    expect(hasDownService(undefined)).toBe(false)
    expect(hasDownService([])).toBe(false)
  })
})
