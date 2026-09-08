import { describe, expect, test } from 'vitest'
import { ADMIN_TOKEN_ENV_VAR } from '../../src/admin/constants.js'
import type { DispatchOptions } from '../../src/cli/dispatch-types.js'
import {
  SESSION_ENV_SEAMS,
  sessionEnvOf,
  withSeamEnv,
  withSessionToken,
} from '../../src/tui/session-env.js'

/**
 * The one path the session token takes into the dispatcher (mcpcut phase 2,
 * task 11). Two properties matter and both are asserted here: every seam that
 * resolves `MCP_ADMIN_TOKEN` gets the environment, and nothing else about the
 * caller's options changes — a lost `admin.journalDir` would silently point a
 * command at the operator's real install instead of the one under test.
 */

/**
 * Compile-time half of the seam list: each seam named in `SESSION_ENV_SEAMS`
 * must be a key of `DispatchOptions` whose options type carries `env`. Were
 * one to lose the field, `seamsCarryEnv` below stops type-checking — which is
 * the point, since `withSessionToken` would otherwise be inventing a seam.
 */
type SessionEnvSeam = (typeof SESSION_ENV_SEAMS)[number]
type EnvBearingSeam<K extends keyof DispatchOptions> = NonNullable<DispatchOptions[K]> extends {
  env?: NodeJS.ProcessEnv
}
  ? K
  : never
type SeamsCarryEnv = SessionEnvSeam extends EnvBearingSeam<SessionEnvSeam> ? true : false

const SESSION_ENV: NodeJS.ProcessEnv = { PATH: '/usr/bin', [ADMIN_TOKEN_ENV_VAR]: 'mcpa_session' }

/** A base with plain data only, so `structuredClone` can prove it survived. */
function baseOptions(): DispatchOptions {
  return {
    journalDir: '/data/journal',
    admin: { journalDir: '/data/journal' },
    services: { install: { kind: 'absent', path: '/home/alice/.mcpcut/config.json' } },
    vault: { env: { PATH: '/bin' } },
  }
}

describe('SESSION_ENV_SEAMS', () => {
  test('names the nine command seams that resolve an admin token', () => {
    expect(SESSION_ENV_SEAMS).toEqual([
      'approvals',
      'server',
      'agent',
      'group',
      'vault',
      'policy',
      'services',
      'setup',
      'admin',
    ])
  })

  test('every named seam carries an `env` field in DispatchOptions', () => {
    const seamsCarryEnv: SeamsCarryEnv = true

    expect(seamsCarryEnv).toBe(true)
  })
})

describe('withSeamEnv', () => {
  test('sets the environment on every listed seam', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', MCPCUT_CONFIG: '/tmp/config.json' }

    const options = withSeamEnv(baseOptions(), env)

    for (const seam of SESSION_ENV_SEAMS) {
      expect(options[seam]?.env, `seam ${seam}`).toBe(env)
    }
  })

  test('adds no token: the wizard runs before the install has an admin', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }

    const options = withSeamEnv(baseOptions(), env)

    for (const seam of SESSION_ENV_SEAMS) {
      expect(options[seam]?.env?.[ADMIN_TOKEN_ENV_VAR], `seam ${seam}`).toBeUndefined()
    }
  })

  test('leaves the base untouched', () => {
    const base = baseOptions()
    const before = structuredClone(base)

    withSeamEnv(base, { PATH: '/usr/bin' })

    expect(base).toEqual(before)
  })

  test('does not touch the seams whose environment means something else', () => {
    const options = withSeamEnv(baseOptions(), { PATH: '/usr/bin' })

    expect(options.journalDir).toBe('/data/journal')
    expect(options.wrap).toBeUndefined()
    expect(options.ui).toBeUndefined()
  })
})

describe('withSessionToken', () => {
  test('sets the environment on every listed seam', () => {
    const options = withSessionToken(baseOptions(), SESSION_ENV)

    for (const seam of SESSION_ENV_SEAMS) {
      expect(options[seam]?.env, `seam ${seam}`).toBe(SESSION_ENV)
    }
  })

  test('leaves the base untouched', () => {
    const base = baseOptions()
    const before = structuredClone(base)

    withSessionToken(base, SESSION_ENV)

    expect(base).toEqual(before)
    expect(base.vault?.env).toEqual({ PATH: '/bin' })
  })

  test('keeps the fields a seam already carried', () => {
    const options = withSessionToken(baseOptions(), SESSION_ENV)

    expect(options.services?.install).toEqual({
      kind: 'absent',
      path: '/home/alice/.mcpcut/config.json',
    })
  })

  test('keeps the journalDir the console pinned on the admin seam', () => {
    const options = withSessionToken(baseOptions(), SESSION_ENV)

    expect(options.admin).toEqual({ journalDir: '/data/journal', env: SESSION_ENV })
  })

  test('does not touch the seams whose environment means something else', () => {
    const options = withSessionToken(baseOptions(), SESSION_ENV)

    expect(options.journalDir).toBe('/data/journal')
    expect(options.wrap).toBeUndefined()
    expect(options.connect).toBeUndefined()
    expect(options.serve).toBeUndefined()
    expect(options.ui).toBeUndefined()
  })

  test('fills a seam the caller never set', () => {
    const options = withSessionToken({}, SESSION_ENV)

    expect(options.agent).toEqual({ env: SESSION_ENV })
  })
})

describe('sessionEnvOf', () => {
  test('adds the token to the environment it was given', () => {
    const env = sessionEnvOf({ PATH: '/usr/bin' }, 'mcpa_token')

    expect(env).toEqual({ PATH: '/usr/bin', [ADMIN_TOKEN_ENV_VAR]: 'mcpa_token' })
  })

  test('overrides a token the process environment already carried', () => {
    const base: NodeJS.ProcessEnv = { [ADMIN_TOKEN_ENV_VAR]: 'mcpa_shell' }

    expect(sessionEnvOf(base, 'mcpa_console')[ADMIN_TOKEN_ENV_VAR]).toBe('mcpa_console')
    expect(base[ADMIN_TOKEN_ENV_VAR]).toBe('mcpa_shell')
  })
})
