import { describe, expect, test } from 'vitest'
import { SUPERVISOR_ENV_VAR, SUPERVISORS } from '../../src/setup/constants.js'
import { defaultInstallConfig } from '../../src/setup/defaults.js'
import { InvalidSupervisorEnvError, resolveSupervisor } from '../../src/setup/supervisor.js'
import type { InstallConfig } from '../../src/setup/schema.js'

/**
 * `MCPCUT_SUPERVISOR` (SEC-M3): the runtime override that says who owns the
 * service processes. It was declared and documented from the first wave but
 * never read, so a container that exported it still got a CLI willing to spawn
 * a second copy of every daemon compose already runs.
 *
 * Ranked like every other override in this area: a non-empty environment
 * variable beats the config, and an unset or empty one is not a value at all.
 */

function configWith(supervisor?: InstallConfig['supervisor']): InstallConfig {
  const base = defaultInstallConfig('/srv/plane')
  return supervisor === undefined ? base : { ...base, supervisor }
}

describe('resolveSupervisor', () => {
  test('the environment outranks the config', () => {
    const resolved = resolveSupervisor({ [SUPERVISOR_ENV_VAR]: 'external' }, configWith('mcpcut'))

    expect(resolved).toBe('external')
  })

  test('an empty variable counts as not set, like every other env seam', () => {
    const resolved = resolveSupervisor({ [SUPERVISOR_ENV_VAR]: '' }, configWith('external'))

    expect(resolved).toBe('external')
  })

  test('the config answers when nothing is exported', () => {
    expect(resolveSupervisor({}, configWith('external'))).toBe('external')
  })

  test('an install that says nothing about it resolves to nothing', () => {
    expect(resolveSupervisor({}, configWith())).toBeUndefined()
  })

  test('every member of the closed list is accepted from the environment', () => {
    for (const supervisor of SUPERVISORS) {
      expect(resolveSupervisor({ [SUPERVISOR_ENV_VAR]: supervisor }, configWith())).toBe(supervisor)
    }
  })

  test('a value outside the closed list is refused, never quietly ignored', () => {
    // Ignoring it would leave an operator convinced the services are managed
    // by compose while this CLI spawns its own — the exact clash C7 forbids.
    expect(() =>
      resolveSupervisor({ [SUPERVISOR_ENV_VAR]: 'systemd' }, configWith('external')),
    ).toThrow(InvalidSupervisorEnvError)
  })

  test('the refusal names the variable, the value and the two legal words', () => {
    try {
      resolveSupervisor({ [SUPERVISOR_ENV_VAR]: 'systemd' }, configWith())
      expect.unreachable('an invalid supervisor must throw')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidSupervisorEnvError)
      if (!(error instanceof InvalidSupervisorEnvError)) return
      expect(error.message).toBe(
        `Invalid ${SUPERVISOR_ENV_VAR} "systemd": expected mcpcut or external.`,
      )
      expect(error.name).toBe('InvalidSupervisorEnvError')
      expect(error.variable).toBe(SUPERVISOR_ENV_VAR)
    }
  })
})
