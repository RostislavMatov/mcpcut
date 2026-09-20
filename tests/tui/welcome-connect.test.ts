import { describe, expect, test } from 'vitest'
import { parseRemoteUrl, type RemoteUrl } from '../../src/tui/remote/url.js'
import {
  CONNECT_HOST_FIELD,
  CONNECT_PORT_FIELD,
  CONNECT_PROTOCOL_FIELD,
  connectFormOf,
  remoteUrlOf,
} from '../../src/tui/welcome-connect.js'

/**
 * The welcome screen's "connect" form (2026-09-19): the one place a host, a
 * port and a protocol become the address `--remote` itself would be given —
 * or are refused in `parseRemoteUrl`'s own words.
 */

function values(overrides: Record<string, string> = {}): Record<string, string> {
  return { [CONNECT_HOST_FIELD]: '', [CONNECT_PORT_FIELD]: '', [CONNECT_PROTOCOL_FIELD]: 'https', ...overrides }
}

describe('remoteUrlOf: host + port + protocol', () => {
  test('builds an https origin from a bare host and a port', () => {
    expect(remoteUrlOf(values({ [CONNECT_HOST_FIELD]: 'box.example', [CONNECT_PORT_FIELD]: '8091' }))).toEqual({
      ok: true,
      url: 'https://box.example:8091',
    })
  })

  test('honours Protocol http', () => {
    const result = remoteUrlOf(
      values({ [CONNECT_HOST_FIELD]: '10.0.0.5', [CONNECT_PORT_FIELD]: '8091', [CONNECT_PROTOCOL_FIELD]: 'http' }),
    )
    expect(result).toEqual({ ok: true, url: 'http://10.0.0.5:8091' })
  })

  test('an empty host is refused on the host field', () => {
    expect(remoteUrlOf(values({ [CONNECT_PORT_FIELD]: '8091' }))).toEqual({
      ok: false,
      field: CONNECT_HOST_FIELD,
      message: 'required',
    })
  })

  test('an empty port is refused on the port field, when host is not a whole URL', () => {
    expect(remoteUrlOf(values({ [CONNECT_HOST_FIELD]: 'box.example' }))).toEqual({
      ok: false,
      field: CONNECT_PORT_FIELD,
      message: 'required',
    })
  })

  test.each(['0', '65536', '999999', 'abc', '-1', '8091x'])(
    'an out-of-range or non-numeric port %s is refused on the port field',
    (port) => {
      const result = remoteUrlOf(values({ [CONNECT_HOST_FIELD]: 'box.example', [CONNECT_PORT_FIELD]: port }))
      expect(result).toEqual({ ok: false, field: CONNECT_PORT_FIELD, message: 'expected 1..65535' })
    },
  )

  test('the boundary ports 1 and 65535 are accepted', () => {
    expect(remoteUrlOf(values({ [CONNECT_HOST_FIELD]: 'h', [CONNECT_PORT_FIELD]: '1' }))).toMatchObject({ ok: true })
    expect(remoteUrlOf(values({ [CONNECT_HOST_FIELD]: 'h', [CONNECT_PORT_FIELD]: '65535' }))).toMatchObject({
      ok: true,
    })
  })
})

describe('remoteUrlOf: a whole URL pasted into Host', () => {
  test('takes protocol and port from the URL, ignoring the separate fields', () => {
    const result = remoteUrlOf(
      values({ [CONNECT_HOST_FIELD]: 'http://box.example:9000', [CONNECT_PROTOCOL_FIELD]: 'https' }),
    )
    expect(result).toEqual({ ok: true, url: 'http://box.example:9000' })
  })

  test('the port field may be left empty when Host is a whole URL', () => {
    const result = remoteUrlOf(values({ [CONNECT_HOST_FIELD]: 'https://box.example' }))
    expect(result).toEqual({ ok: true, url: 'https://box.example' })
  })

  test('a scheme other than http/https is refused by parseRemoteUrl, not silently combined', () => {
    const result = remoteUrlOf(values({ [CONNECT_HOST_FIELD]: 'ftp://box.example' }))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.field).toBeUndefined()
    expect(!result.ok && result.message).toContain('http://')
  })
})

describe('remoteUrlOf: garbage is refused by the ONE validator, not a bespoke message', () => {
  test('whitespace in a bare host becomes an unparsable URL, refused by parseRemoteUrl', () => {
    const result = remoteUrlOf(values({ [CONNECT_HOST_FIELD]: 'not a host', [CONNECT_PORT_FIELD]: '8091' }))

    expect(result.ok).toBe(false)
    expect(!result.ok && result.field).toBeUndefined()
    expect(!result.ok && result.message).not.toBe('')
  })

  test('a whole URL with credentials is refused in parseRemoteUrl’s own words', () => {
    const result = remoteUrlOf(values({ [CONNECT_HOST_FIELD]: 'https://admin:secret@box.example' }))

    expect(result).toEqual({ ok: false, message: expect.stringContaining('credentials') })
  })

  test('a whole URL with a path is refused in parseRemoteUrl’s own words', () => {
    const result = remoteUrlOf(values({ [CONNECT_HOST_FIELD]: 'https://box.example/admin' }))

    expect(result).toEqual({ ok: false, message: expect.stringContaining('path') })
  })
})

describe('remoteUrlOf: surrounding whitespace', () => {
  test('a host with leading/trailing spaces is trimmed before it is judged', () => {
    const result = remoteUrlOf(values({ [CONNECT_HOST_FIELD]: '  box.example  ', [CONNECT_PORT_FIELD]: '8091' }))

    expect(result).toEqual({ ok: true, url: 'https://box.example:8091' })
  })
})

/**
 * `connectFormOf`: the connect form prefilled from an address already known —
 * the saved one, or `mcpcut --connect <url>`'s argument (2026-09-20) — split
 * back into the three fields an operator can edit individually, rather than
 * one opaque "whole URL" string in Host.
 */
describe('connectFormOf: prefilling from a known address', () => {
  function urlOf(raw: string): RemoteUrl {
    const result = parseRemoteUrl(raw)
    if (!result.ok) throw new Error(`test fixture: ${raw} does not parse`)
    return result.url
  }

  test('an explicit port round-trips exactly', () => {
    const form = connectFormOf(urlOf('https://box.example:8091'))

    expect(form.fields.map((field) => [field.spec.name, field.value])).toEqual([
      [CONNECT_HOST_FIELD, 'box.example'],
      [CONNECT_PORT_FIELD, '8091'],
      [CONNECT_PROTOCOL_FIELD, 'https'],
    ])
  })

  test('a default https port (none in the origin) is shown as 443', () => {
    const form = connectFormOf(urlOf('https://box.example'))

    expect(form.fields.find((field) => field.spec.name === CONNECT_PORT_FIELD)?.value).toBe('443')
    expect(form.fields.find((field) => field.spec.name === CONNECT_PROTOCOL_FIELD)?.value).toBe('https')
  })

  test('a default http port (none in the origin) is shown as 80', () => {
    const form = connectFormOf(urlOf('http://box.example'))

    expect(form.fields.find((field) => field.spec.name === CONNECT_PORT_FIELD)?.value).toBe('80')
  })

  test('the form this builds resubmits to the very same origin', () => {
    const url = urlOf('https://box.example:8091')

    const resubmitted = remoteUrlOf(
      Object.fromEntries(connectFormOf(url).fields.map((field) => [field.spec.name, field.value])),
    )

    expect(resubmitted).toEqual({ ok: true, url: 'https://box.example:8091' })
  })

  test('is otherwise the ordinary fresh form: focus on the first field, no errors', () => {
    const form = connectFormOf(urlOf('https://box.example:8091'))

    expect(form.focus).toBe(0)
    expect(form.fields.every((field) => field.error === undefined)).toBe(true)
  })
})
