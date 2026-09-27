/**
 * The seam between the hub and whatever creates tenant installs (plan
 * `hub-signin-accounts`, Task 5; PRD `hosted-accounts` phase 3). The hub
 * decides WHO gets an install; the orchestrator is the only thing that knows
 * HOW one is made, rotated or removed. Phase 3 supplies a real
 * implementation and passes it to `runHubCli` (`cli.ts`) — nothing else in
 * the hub changes.
 *
 * Until then `serve` runs with `unavailableOrchestrator` (H5): `available` is
 * false, so every new sign-in lands on the waitlist and no install is ever
 * promised, and the three methods reject if anyone calls them regardless.
 */

export interface CreateInstallInput {
  readonly githubId: number
  readonly login: string
  readonly subdomain: string
}

export interface OwnerTokenGrant {
  /** The install's plaintext owner token — shown to its person once, never stored by the hub. */
  readonly ownerToken: string
}

/**
 * Contract for implementations: a failure is a rejected promise whose
 * `Error` message carries no token or secret — the hub logs `name: message`
 * of whatever the orchestrator throws (through `describeOrchestratorError`,
 * which redacts anything token-shaped regardless), and shows the person
 * only a fixed "try again" page.
 */
export interface Orchestrator {
  /** Whether installs can be created right now. Read on every sign-in. */
  readonly available: boolean
  /** Creates the tenant's install and returns its first owner token. */
  create(input: CreateInstallInput): Promise<OwnerTokenGrant>
  /** Mints a new owner token for an existing install; the old one stops working. */
  rotateOwnerToken(subdomain: string): Promise<OwnerTokenGrant>
  /** Removes the install and everything in it. Resolves only once it is gone. */
  remove(subdomain: string): Promise<void>
}

/** Thrown by `unavailableOrchestrator` — the hub treats it like any other failure. */
export class OrchestratorUnavailableError extends Error {
  override readonly name = 'OrchestratorUnavailableError'

  constructor(operation: string) {
    super(`orchestrator unavailable: cannot ${operation} (hosted installs are not open yet)`)
  }
}

/** The phase-2 stand-in: nothing can be created, rotated or removed. */
export const unavailableOrchestrator: Orchestrator = Object.freeze({
  available: false,
  create: () => Promise.reject(new OrchestratorUnavailableError('create an install')),
  rotateOwnerToken: () => Promise.reject(new OrchestratorUnavailableError('rotate an owner token')),
  remove: () => Promise.reject(new OrchestratorUnavailableError('remove an install')),
})

/**
 * Everything token-shaped: mcpcut's own tokens (`mcpo_`, `mcpa_`, `mcps_`, …),
 * GitHub's (`ghp_`/`gho_`/`ghs_`/`ghu_`, `github_pat_`), and any long
 * base64url or hex run (hex is a subset of the base64url alphabet). Over-
 * redacting a log line costs a little readability; under-redacting leaks a
 * credential into the host's logs.
 */
const TOKEN_SHAPES: readonly RegExp[] = [
  /github_pat_[A-Za-z0-9_]+/g,
  /mcp[a-z]_[A-Za-z0-9_-]{8,}/g,
  /gh[opsu]_[A-Za-z0-9]{8,}/g,
  /[A-Za-z0-9_-]{32,}/g,
]

const REDACTED = '[redacted]'

function redactTokens(text: string): string {
  return TOKEN_SHAPES.reduce((redacted, shape) => redacted.replace(shape, REDACTED), text)
}

/**
 * The one way an orchestrator failure reaches a log line: error class and
 * message only (never a body or a header), with anything token-shaped
 * replaced by `[redacted]` — the structural guarantee behind the contract
 * above, for the implementation that breaks it.
 */
export function describeOrchestratorError(error: unknown): string {
  if (!(error instanceof Error)) return 'non-Error value thrown'
  return redactTokens(`${error.name}: ${error.message}`)
}
