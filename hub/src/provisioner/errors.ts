import { DockerApiError } from './docker-wire.js'

/**
 * The provisioner's one error type (plan `tenant-orchestrator`, Task 4). Its
 * `code` is what the HTTP API answers with and what the hub may act on; its
 * message is built here from fixed text, the operation and a Docker error's
 * own (already sanitised, redacted and cut) message — never from an exec's
 * output, which is where an owner token lives.
 */

export type ProvisionerErrorCode =
  /** The request named something the templates refuse — nothing reached Docker. */
  | 'invalid-input'
  /** The tenant's container, network or volume is already there. */
  | 'exists'
  /** No such tenant. */
  | 'not-found'
  /** An object with the tenant's name carries another tenant's label. */
  | 'not-ours'
  /** The host already holds as many tenants as the provisioner may create. */
  | 'capacity'
  /** The install did not answer `status` in time, or is not running. */
  | 'not-ready'
  /** The install answered, but not with what the contract says. */
  | 'bad-output'
  /** Docker refused or could not be reached. */
  | 'docker'
  | 'internal'

export class ProvisionerError extends Error {
  override readonly name = 'ProvisionerError'
  readonly code: ProvisionerErrorCode

  constructor(code: ProvisionerErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

const HTTP_CONFLICT = 409

/**
 * Any failure as a `ProvisionerError`. A Docker 409 on create is a name that
 * is taken; the rest of Docker's failures keep the wire's safe message. A
 * non-Docker, non-provisioner error is not quoted at all: its message is
 * nobody's contract.
 */
export function asProvisionerError(error: unknown, operation: string): ProvisionerError {
  if (error instanceof ProvisionerError) return error
  if (error instanceof DockerApiError) {
    if (error.status === HTTP_CONFLICT) return new ProvisionerError('exists', `${operation}: ${error.message}`)
    return new ProvisionerError('docker', `${operation}: ${error.message}`)
  }
  return new ProvisionerError('internal', `${operation}: failed unexpectedly`)
}
