import { SUPERVISOR_ENV_VAR, SUPERVISORS, type Supervisor } from './constants.js'
import type { InstallConfig } from './schema.js'

/**
 * Who owns the service processes, at run time (SEC-M3).
 *
 * `MCPCUT_SUPERVISOR` existed from the first wave — declared, documented and
 * never read — so a container that exported it still got a CLI willing to
 * spawn a second copy of every daemon compose already runs. It is resolved
 * here, on the same ranking every other override in this area uses: a
 * non-empty environment variable beats the config, and an unset or empty one
 * is not a value at all (`src/cli/admin-token.ts`).
 *
 * The value is deliberately NOT written into the config file by `setup`: it
 * describes how THIS host runs the install, not what the install is. A
 * container that exports it and a shell that does not must be able to read the
 * same config and reach different, correct conclusions.
 *
 * NOT part of the `src/config.ts` resolution chain (see `./constants.ts`).
 */

/**
 * An environment variable that cannot mean what it says. Refused rather than
 * ignored, for the reason `InvalidBindEnvError` (`./bind.ts`) states: a value
 * that silently fell back would leave an operator convinced their services are
 * managed by compose while this CLI spawns its own onto the same ports.
 */
export class InvalidSupervisorEnvError extends Error {
  readonly variable: string

  constructor(raw: string) {
    super(`Invalid ${SUPERVISOR_ENV_VAR} "${raw}": expected ${SUPERVISORS.join(' or ')}.`)
    this.name = 'InvalidSupervisorEnvError'
    this.variable = SUPERVISOR_ENV_VAR
  }
}

/** The supervisor in force, ranked env > config. Throws `InvalidSupervisorEnvError`. */
export function resolveSupervisor(
  env: NodeJS.ProcessEnv,
  config: InstallConfig,
): InstallConfig['supervisor'] {
  const raw = env[SUPERVISOR_ENV_VAR]
  if (raw === undefined || raw === '') return config.supervisor
  const match = SUPERVISORS.find((supervisor: Supervisor) => supervisor === raw)
  if (match === undefined) throw new InvalidSupervisorEnvError(raw)
  return match
}

/**
 * The config as this host runs it. Kept next to the resolver so every caller
 * applies the override the same way — the manager and `--start` must agree
 * about who owns the processes, or one of them spawns what the other reports.
 */
export function withResolvedSupervisor(
  config: InstallConfig,
  env: NodeJS.ProcessEnv,
): InstallConfig {
  const supervisor = resolveSupervisor(env, config)
  return supervisor === undefined ? config : { ...config, supervisor }
}
