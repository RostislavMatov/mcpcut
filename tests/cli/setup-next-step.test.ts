import { describe, expect, test } from 'vitest'
import { setupNextStep } from '../../src/cli/setup-next-step.js'

const LOOPBACK = { supervisor: 'mcpcut', ui: { host: '127.0.0.1', port: 8091 } } as const

describe('the line setup ends with', () => {
  test('services not started: start them, then the console address and what to sign in with', () => {
    expect(setupNextStep(LOOPBACK, { started: false, noAdmin: false }, {})).toBe(
      'Next: mcpcut start, then open http://127.0.0.1:8091/ and sign in with your admin token.\n',
    )
  })

  test('services started by --start: only the address is left', () => {
    expect(setupNextStep(LOOPBACK, { started: true, noAdmin: false }, {})).toBe(
      'Next: open http://127.0.0.1:8091/ and sign in with your admin token.\n',
    )
  })

  test('under npx the start command is the npx form', () => {
    expect(setupNextStep(LOOPBACK, { started: false, noAdmin: false }, { npm_command: 'exec' })).toMatch(
      /^Next: npx -y mcpcut@\S+ start, then open /,
    )
  })

  test('a public address wins over the bind', () => {
    const config = { ...LOOPBACK, ui: { host: '0.0.0.0', port: 8091, allowedOrigins: ['https://mcp.example.com'] } }

    expect(setupNextStep(config, { started: true, noAdmin: false }, {})).toContain('open https://mcp.example.com/ and')
  })

  test('a wildcard bind is opened on loopback, an IPv6 host in brackets', () => {
    const wildcard = { ...LOOPBACK, ui: { host: '0.0.0.0', port: 9000 } }
    const ipv6 = { ...LOOPBACK, ui: { host: '::1', port: 9000 } }

    expect(setupNextStep(wildcard, { started: true, noAdmin: false }, {})).toContain('http://127.0.0.1:9000/')
    expect(setupNextStep(ipv6, { started: true, noAdmin: false }, {})).toContain('http://[::1]:9000/')
  })

  test('nothing for an external supervisor or --no-admin: their own notices already say what comes next', () => {
    const external = { ...LOOPBACK, supervisor: 'external' }

    expect(setupNextStep(external, { started: false, noAdmin: false }, {})).toBe('')
    expect(setupNextStep(LOOPBACK, { started: false, noAdmin: true }, {})).toBe('')
  })
})
