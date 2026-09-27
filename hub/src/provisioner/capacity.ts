import { ProvisionerError } from './errors.js'
import { createKeyedLock } from './keyed-lock.js'

/**
 * The host's tenant ceiling (security review of the provisioner, MEDIUM-1).
 * Creates of different subdomains run side by side, so the ceiling cannot
 * rest on the per-subdomain lock: N creates would each read "one below the
 * ceiling" before any of them had built a container. Here the check and the
 * reservation of a slot are one step, run one at a time for the whole host.
 *
 * What counts is the union, by subdomain, of the installs Docker already
 * holds and the creates in flight — so an install still being built counts
 * once whether or not its container exists yet. A slot is released when its
 * create settles, success or failure; a successful create's container is
 * then what keeps it counted.
 */

/** Gives the slot back; calling it again does nothing. */
export type ReleaseSlot = () => void

export interface TenantSlots {
  /**
   * Reserves a slot for `subdomain`, or refuses with `capacity`.
   * `existing` lists the subdomains of the installs Docker holds now.
   */
  reserve(subdomain: string, existing: () => Promise<readonly string[]>): Promise<ReleaseSlot>
}

const HOST_KEY = 'host'

export function createTenantSlots(maxTenants: number): TenantSlots {
  const lock = createKeyedLock()
  let inFlight: ReadonlySet<string> = new Set()
  const release = (subdomain: string): ReleaseSlot => {
    let released = false
    return () => {
      if (released) return
      released = true
      inFlight = new Set([...inFlight].filter((held) => held !== subdomain))
    }
  }
  return {
    reserve: (subdomain, existing) =>
      lock.run(HOST_KEY, async () => {
        const counted = new Set([...(await existing()), ...inFlight, subdomain])
        if (counted.size > maxTenants) {
          throw new ProvisionerError('capacity', `create: the host already holds ${maxTenants} tenants`)
        }
        inFlight = new Set([...inFlight, subdomain])
        return release(subdomain)
      }),
  }
}
