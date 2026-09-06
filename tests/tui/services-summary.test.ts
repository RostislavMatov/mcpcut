import { describe, expect, test } from 'vitest'
import { statusJson } from '../../src/services/format.js'
import type { ServiceStatus } from '../../src/services/manager-types.js'
import {
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
        { ...STOPPED_SERVE, state: 'external' },
      ]),
    )

    expect(servicesHeaderPart(parsed)).toBe('ui ◐ 127.0.0.1:8091 · serve ○ 127.0.0.1:8090')
  })

  test('brackets a bare IPv6 bind exactly once', () => {
    const parsed = parseServicesJson(statusJson([{ ...RUNNING_UI, host: '::1' }]))

    expect(servicesHeaderPart(parsed)).toBe('ui ● [::1]:8091')
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
